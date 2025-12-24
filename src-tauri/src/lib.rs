// src-tauri/src/lib.rs
use tauri::command;
use std::f64::consts::PI;
use geo::{Coord, LineString, MultiPolygon, Polygon};
use geo::bounding_rect::BoundingRect;
use geo::MapCoords;
use svg::Document;
use svg::node::element::{Path, Rectangle};
use svg::node::element::path::Data;
use std::fs::File;
use std::io::Write;
use csgrs::sketch::Sketch;
// use csgrs::mesh::Mesh; // Removed unused import
use csgrs::traits::CSG; 

#[derive(Debug, serde::Deserialize)]
struct ExportPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, serde::Deserialize)]
struct ExportShape {
    shape_type: String, // "circle", "rect"
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    diameter: Option<f64>,
    angle: Option<f64>,
    depth: f64,
}

#[derive(Debug, serde::Deserialize)]
struct ExportRequest {
    filepath: String,
    file_type: String, // "SVG", "DXF", "STEP", "STL"
    machining_type: String, // "Cut" or "Carved/Printed"
    cut_direction: String, // "Top" or "Bottom"
    outline: Vec<ExportPoint>,
    shapes: Vec<ExportShape>,
    layer_thickness: f64,
    stl_content: Option<Vec<u8>>, // New Field for binary STL data
}

#[command]
fn export_layer_files(request: ExportRequest) {
    println!("--- EXPORT REQUEST RECEIVED ---");
    println!("Target Path: {}", request.filepath);
    println!("Format: {}", request.file_type);
    println!("Machining Type: {}", request.machining_type);
    println!("Cut Direction: {}", request.cut_direction);
    println!("Layer Thickness: {}", request.layer_thickness);
    println!("Board Outline Points: {}", request.outline.len());
    println!("Cut/Carve Shapes: {}", request.shapes.len());
    if let Some(s) = request.shapes.first() {
        println!("Sample Shape 1: {:?}", s);
    }
    println!("-------------------------------");

    if request.file_type == "STL" {
        if let Some(content) = &request.stl_content {
            // Write the pre-computed STL data from Typescript directly to file
            match File::create(&request.filepath) {
                Ok(mut file) => {
                    if let Err(e) = file.write_all(content) {
                         eprintln!("Error writing STL file: {}", e);
                    } else {
                         println!("STL export successful (Using pre-computed mesh).");
                    }
                },
                Err(e) => eprintln!("Error creating file for STL: {}", e),
            }
        } else {
             eprintln!("STL export requested but no mesh content provided.");
        }
        return;
    }

    if request.file_type == "SVG" {
        if request.machining_type == "Carved/Printed" {
            // New logic for depth map export
            if let Err(e) = generate_depth_map_svg(&request) {
                eprintln!("Error generating Depth Map SVG: {}", e);
            } else {
                println!("Depth Map SVG export successful.");
            }
        } else {
            // Original logic for profile cut export
            if let Err(e) = generate_profile_svg(&request) {
                eprintln!("Error generating Profile SVG: {}", e);
            } else {
                println!("Profile SVG export successful.");
            }
        }
    } else if request.file_type == "DXF" {
        if let Err(e) = generate_dxf(&request) {
            eprintln!("Error generating DXF: {}", e);
        } else {
            println!("DXF export successful.");
        }
    }
}

// Helper to get unioned geometry for profile cuts
fn get_geometry_unioned(request: &ExportRequest) -> Option<(Polygon<f64>, MultiPolygon<f64>)> {
    // 1. Convert Board Outline to Polygon
    let outline_coords: Vec<Coord<f64>> = request.outline.iter()
        .map(|p| Coord { x: p.x, y: p.y })
        .collect();

    if outline_coords.is_empty() {
        return None;
    }

    let outline_ls = LineString::new(outline_coords);
    let board_poly = Polygon::new(outline_ls, vec![]);

    // 2. Convert Shapes to Sketch and Union using csgrs
    let mut united_sketch: Option<Sketch<()>> = None;

    for shape in &request.shapes {
        if let Some(poly) = shape_to_polygon(shape) {
            // Convert geo::Polygon to Sketch
            // Note: geo 0.29.3 and csgrs 0.20.1 are compatible
            let geom = geo::Geometry::Polygon(poly);
            // Convert Geometry to GeometryCollection using .into()
            let shape_sketch = Sketch::from_geo(geom.into(), None); 

            if let Some(current) = united_sketch {
                united_sketch = Some(current.union(&shape_sketch));
            } else {
                united_sketch = Some(shape_sketch);
            }
        }
    }
    
    // 3. Convert Sketch back to MultiPolygon for export
    let united_shapes = if let Some(sketch) = united_sketch {
        let mut polys = Vec::new();
        // Sketch contains a geo::GeometryCollection
        for geom in sketch.geometry {
            match geom {
                geo::Geometry::Polygon(p) => polys.push(p),
                geo::Geometry::MultiPolygon(mp) => polys.extend(mp.0),
                _ => {} // Ignore other geometry types if any
            }
        }
        MultiPolygon::new(polys)
    } else {
        MultiPolygon::new(vec![])
    };
    
    Some((board_poly, united_shapes))
}

// Helper to get raw polygon list for depth maps (no union)
fn get_board_and_shapes_raw(request: &ExportRequest) -> Option<(Polygon<f64>, Vec<(Polygon<f64>, f64)>)> {
    // 1. Convert Board Outline to Polygon
    let outline_coords: Vec<Coord<f64>> = request.outline.iter()
        .map(|p| Coord { x: p.x, y: p.y })
        .collect();

    if outline_coords.is_empty() {
        return None;
    }

    let outline_ls = LineString::new(outline_coords);
    let board_poly = Polygon::new(outline_ls, vec![]);

    // 2. Convert Shapes to List of (Polygon, Depth)
    let mut shape_list = Vec::new();

    for shape in &request.shapes {
        if let Some(poly) = shape_to_polygon(shape) {
            shape_list.push((poly, shape.depth));
        }
    }

    Some((board_poly, shape_list))
}

fn generate_profile_svg(request: &ExportRequest) -> Result<(), Box<dyn std::error::Error>> {
    let (board_poly_raw, united_shapes_raw) = match get_geometry_unioned(request) {
        Some(g) => g,
        None => return Ok(()),
    };

    // Transform logic (Standard SVG Y-Down flip)
    let transform = |c: Coord<f64>| Coord { x: c.x, y: -c.y };

    let board_poly = board_poly_raw.map_coords(transform);
    let united_shapes = united_shapes_raw.map_coords(transform);

    // Setup SVG Document
    let bounds = board_poly.bounding_rect().unwrap_or_else(|| {
        geo::Rect::new(Coord { x: 0.0, y: 0.0 }, Coord { x: 100.0, y: 100.0 })
    });

    let min_x = bounds.min().x;
    let min_y = bounds.min().y;
    let width = bounds.width();
    let height = bounds.height();

    let mut document = Document::new()
        .set("viewBox", format!("{} {} {} {}", min_x, min_y, width, height))
        .set("width", format!("{}mm", width))
        .set("height", format!("{}mm", height))
        .set("xmlns", "http://www.w3.org/2000/svg");

    // Board Outline Path (Black)
    let outline_data = polygon_to_path_data(&board_poly);
    let outline_path = Path::new()
        .set("fill", "none")
        .set("stroke", "black")
        .set("stroke-width", "0.1mm")
        .set("d", outline_data);
    document = document.add(outline_path);

    // United Shapes Path (Red)
    if !united_shapes.0.is_empty() {
        let mut shapes_data = Data::new();
        for poly in &united_shapes.0 {
            shapes_data = append_polygon_to_data(shapes_data, poly);
        }

        let shapes_path = Path::new()
            .set("fill", "none")
            .set("stroke", "red")
            .set("stroke-width", "0.1mm")
            .set("d", shapes_data);
        document = document.add(shapes_path);
    }

    svg::save(&request.filepath, &document)?;

    Ok(())
}

fn generate_depth_map_svg(request: &ExportRequest) -> Result<(), Box<dyn std::error::Error>> {
    let (board_poly_raw, shapes_raw) = match get_board_and_shapes_raw(request) {
        Some(g) => g,
        None => return Ok(()),
    };

    // Check conditions for flipping X:
    // We flip along the Y-axis (negate X) if we are Carving/Printing from the "Bottom".
    let mirror_x = request.cut_direction == "Bottom";

    // Transform logic:
    // 1. SVG coordinate system has Y pointing DOWN. Our CAD uses Y pointing UP. We negate Y (-c.y).
    // 2. If mirror_x is true, we negate X (-c.x) to flip horizontally.
    let transform = |c: Coord<f64>| Coord { 
        x: if mirror_x { -c.x } else { c.x }, 
        y: -c.y 
    };

    let board_poly = board_poly_raw.map_coords(transform);
    
    // Bounds calculation based on board
    let bounds = board_poly.bounding_rect().unwrap_or_else(|| {
        geo::Rect::new(Coord { x: 0.0, y: 0.0 }, Coord { x: 100.0, y: 100.0 })
    });
    
    let min_x = bounds.min().x;
    let min_y = bounds.min().y;
    let width = bounds.width();
    let height = bounds.height();

    let mut document = Document::new()
        .set("viewBox", format!("{} {} {} {}", min_x, min_y, width, height))
        .set("width", format!("{}mm", width))
        .set("height", format!("{}mm", height))
        .set("xmlns", "http://www.w3.org/2000/svg")
        .set("style", "background-color: black");

    // 1. Background Black Rectangle (100% Cut / Empty Space)
    let bg_rect = Rectangle::new()
        .set("x", min_x)
        .set("y", min_y)
        .set("width", width)
        .set("height", height)
        .set("fill", "black");
    document = document.add(bg_rect);

    // 2. Board Solid White (0% Cut / Material Surface)
    let board_data = polygon_to_path_data(&board_poly);
    let board_path = Path::new()
        .set("fill", "white")
        .set("stroke", "none") 
        .set("d", board_data);
    document = document.add(board_path);

    // 3. Process Shapes Logic
    // `shapes_raw` is ordered Bottom -> Top.
    
    struct Layer {
        sketch: Sketch<()>,
        depth: f64,
    }

    // A. Merge adjacent shapes with same depth
    let mut layers: Vec<Layer> = Vec::new();
    for (poly_raw, depth) in shapes_raw {
        let poly = poly_raw.map_coords(transform);
        let geom = geo::Geometry::Polygon(poly);
        let sketch = Sketch::from_geo(geom.into(), None);

        if let Some(last) = layers.last_mut() {
             if (last.depth - depth).abs() < 1e-6 {
                 last.sketch = last.sketch.union(&sketch);
                 continue;
             }
        }
        layers.push(Layer { sketch, depth });
    }

    // B. Compute Visible Regions
    // We iterate from Top (end) to Bottom (start).
    // A layer is visible except where it is obscured by *higher* layers.
    // Optimization: Only subtract higher layers if they have a *different* depth.
    // If they have the same depth, they merge naturally in the final step.
    
    let mut visible_parts: Vec<(f64, Sketch<()>)> = Vec::new();
    
    // Store union of shapes for each depth encountered so far (from Top)
    // Used to subtract only shapes of *different* depth.
    let mut processed_masks_by_depth: Vec<(f64, Sketch<()>)> = Vec::new();

    for layer in layers.iter().rev() {
        let mut visible = layer.sketch.clone();

        // Subtract overlapping shapes from higher layers (processed_masks)
        // BUT only if depths differ.
        let mut subtraction_mask: Option<Sketch<()>> = None;
        
        for (d, mask_sketch) in &processed_masks_by_depth {
            if (d - layer.depth).abs() > 1e-6 {
                if let Some(curr) = subtraction_mask {
                    subtraction_mask = Some(curr.union(mask_sketch));
                } else {
                    subtraction_mask = Some(mask_sketch.clone());
                }
            }
        }

        if let Some(mask) = subtraction_mask {
            visible = visible.difference(&mask);
        }

        if !visible.geometry.is_empty() {
             visible_parts.push((layer.depth, visible));
        }

        // Add CURRENT layer (full shape) to the masks for future (lower) layers
        let mut found = false;
        for (d, mask_sketch) in &mut processed_masks_by_depth {
            if (*d - layer.depth).abs() < 1e-6 {
                *mask_sketch = mask_sketch.union(&layer.sketch);
                found = true;
                break;
            }
        }
        if !found {
            processed_masks_by_depth.push((layer.depth, layer.sketch.clone()));
        }
    }

    // C. Group visible parts by Depth and Union them
    // This merges split parts back together if they have the same depth
    let mut final_depth_groups: Vec<(f64, Sketch<()>)> = Vec::new();

    for (depth, sketch) in visible_parts {
        let mut found = false;
        for (d, group_sketch) in &mut final_depth_groups {
            if (*d - depth).abs() < 1e-6 {
                *group_sketch = group_sketch.union(&sketch);
                found = true;
                break;
            }
        }
        if !found {
            final_depth_groups.push((depth, sketch));
        }
    }
    
    // Sort by depth so deep cuts are drawn last (optional if they don't overlap, but good for safety)
    final_depth_groups.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // D. Generate SVG
    for (depth, sketch) in final_depth_groups {
        let mut p_list = Vec::new();
        for geom in sketch.geometry {
            match geom {
                geo::Geometry::Polygon(p) => p_list.push(p),
                geo::Geometry::MultiPolygon(mp) => p_list.extend(mp.0),
                _ => {}
            }
        }
        let final_multipoly = MultiPolygon::new(p_list);

        if !final_multipoly.0.is_empty() {
            let mut shapes_data = Data::new();
            for poly in &final_multipoly.0 {
                shapes_data = append_polygon_to_data(shapes_data, poly);
            }
            
            let mut ratio = depth / request.layer_thickness;
            if ratio < 0.0 { ratio = 0.0; }
            if ratio > 1.0 { ratio = 1.0; }

            let val = (255.0 * (1.0 - ratio)).round() as u8;
            let color = format!("rgb({},{},{})", val, val, val);

            let shape_path = Path::new()
                .set("fill", color)
                .set("stroke", "none")
                .set("d", shapes_data);
            document = document.add(shape_path);
        }
    }

    svg::save(&request.filepath, &document)?;

    Ok(())
}

fn generate_dxf(request: &ExportRequest) -> Result<(), Box<dyn std::error::Error>> {
    let (board_poly, united_shapes) = match get_geometry_unioned(request) {
        Some(g) => g,
        None => return Ok(()),
    };

    let mut file = File::create(&request.filepath)?;

    // Minimal DXF Header
    writeln!(file, "  0\nSECTION\n  2\nHEADER\n  0\nENDSEC")?;
    
    // Entities Section
    writeln!(file, "  0\nSECTION\n  2\nENTITIES")?;

    // Outline: Layer OUTLINE, Color 7 (Black/White)
    write_dxf_polygon(&mut file, &board_poly, "OUTLINE", 7)?;

    // Shapes: Layer CUTS, Color 1 (Red)
    for poly in &united_shapes.0 {
        write_dxf_polygon(&mut file, poly, "CUTS", 1)?;
    }

    writeln!(file, "  0\nENDSEC\n  0\nEOF")?;

    Ok(())
}

fn write_dxf_polygon(file: &mut File, poly: &Polygon<f64>, layer: &str, color: i32) -> std::io::Result<()> {
    write_dxf_polyline(file, poly.exterior(), layer, color)?;
    for interior in poly.interiors() {
        write_dxf_polyline(file, interior, layer, color)?;
    }
    Ok(())
}

fn write_dxf_polyline(file: &mut File, ls: &LineString<f64>, layer: &str, color: i32) -> std::io::Result<()> {
    let mut coords = &ls.0[..];
    if coords.is_empty() {
        return Ok(());
    }
    // For LWPOLYLINE with closed flag (70=1), if the last point duplicates the first, we can skip it.
    if coords.len() > 1 && coords.first() == coords.last() {
        coords = &coords[..coords.len() - 1];
    }

    writeln!(file, "  0\nLWPOLYLINE")?;
    writeln!(file, "  8\n{}", layer)?; // Layer Name
    writeln!(file, " 62\n{}", color)?; // Color Number
    writeln!(file, " 90\n{}", coords.len())?; // Number of vertices
    writeln!(file, " 70\n1")?; // Flag 1 = Closed
    
    for coord in coords {
        writeln!(file, " 10\n{:.4}", coord.x)?;
        writeln!(file, " 20\n{:.4}", coord.y)?;
    }
    Ok(())
}

fn shape_to_polygon(shape: &ExportShape) -> Option<Polygon<f64>> {
    match shape.shape_type.as_str() {
        "rect" => {
            let w = shape.width.unwrap_or(0.0);
            let h = shape.height.unwrap_or(0.0);
            let cx = shape.x;
            let cy = shape.y;
            let angle_deg = shape.angle.unwrap_or(0.0);

            let half_w = w / 2.0;
            let half_h = h / 2.0;

            // Corners relative to center
            let corners = vec![
                (-half_w, -half_h),
                (half_w, -half_h),
                (half_w, half_h),
                (-half_w, half_h),
            ];

            // Rotation
            let rad = angle_deg.to_radians();
            let cos_a = rad.cos();
            let sin_a = rad.sin();

            let rotated_coords: Vec<Coord<f64>> = corners.iter().map(|(x, y)| {
                Coord {
                    x: cx + (x * cos_a - y * sin_a),
                    y: cy + (x * sin_a + y * cos_a),
                }
            }).collect();

            Some(Polygon::new(LineString::new(rotated_coords), vec![]))
        },
        "circle" => {
            let d = shape.diameter.unwrap_or(0.0);
            let r = d / 2.0;
            let cx = shape.x;
            let cy = shape.y;

            // Approximate circle with polygon
            let steps = 64;
            let mut coords = Vec::with_capacity(steps);
            for i in 0..steps {
                let theta = (i as f64 / steps as f64) * 2.0 * PI;
                coords.push(Coord {
                    x: cx + r * theta.cos(),
                    y: cy + r * theta.sin(),
                });
            }

            Some(Polygon::new(LineString::new(coords), vec![]))
        },
        _ => None,
    }
}

fn polygon_to_path_data(poly: &Polygon<f64>) -> Data {
    let mut data = Data::new();
    data = append_linestring_to_data(data, poly.exterior());
    for interior in poly.interiors() {
        data = append_linestring_to_data(data, interior);
    }
    data
}

fn append_polygon_to_data(data: Data, poly: &Polygon<f64>) -> Data {
    let mut d = append_linestring_to_data(data, poly.exterior());
    for interior in poly.interiors() {
        d = append_linestring_to_data(d, interior);
    }
    d
}

fn append_linestring_to_data(data: Data, ls: &LineString<f64>) -> Data {
    let mut d = data;
    let coords = ls.0.as_slice();
    if coords.is_empty() {
        return d;
    }
    d = d.move_to((coords[0].x, coords[0].y));
    for coord in &coords[1..] {
        d = d.line_to((coord.x, coord.y));
    }
    d = d.close();
    d
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Initialize the plugins here
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![export_layer_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}