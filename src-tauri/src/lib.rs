// src-tauri/src/lib.rs
use tauri::command;
mod geometry;
mod optimizer;

use geometry::GeometryInput;
use optimizer::run_optimization;
use std::f64::consts::PI;
use geo::{Coord, LineString, MultiPolygon, Polygon, Intersects, Contains};
use geo::bounding_rect::BoundingRect;
use geo::MapCoords;
use svg::Document;
use svg::node::element::{Path, Rectangle, Circle};
use svg::node::element::path::Data;
use std::fs::File;
use std::io::Write;
use csgrs::sketch::Sketch;
// use csgrs::mesh::Mesh; // Removed unused import
use csgrs::traits::CSG;

use crate::optimizer::debug_split_eval; 

#[derive(Debug, serde::Deserialize, Clone)]
struct ExportVec2 {
    x: f64,
    y: f64,
}

#[derive(Debug, serde::Deserialize, Clone)]
struct ExportPoint {
    x: f64,
    y: f64,
    handle_in: Option<ExportVec2>,
    handle_out: Option<ExportVec2>,
}

#[derive(Debug, serde::Deserialize, Clone)]
struct ExportShape {
    shape_type: String, // "circle", "rect", "line"
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    diameter: Option<f64>,
    angle: Option<f64>,
    corner_radius: Option<f64>,
    thickness: Option<f64>,
    points: Option<Vec<ExportPoint>>,
    depth: f64,
    // NEW: Radius of the ball-nose endmill for gradient generation
    endmill_radius: Option<f64>,
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
            println!("DEBUG: Branch -> Depth Map SVG");
            // New logic for depth map export
            if let Err(e) = generate_depth_map_svg(&request) {
                eprintln!("Error generating Depth Map SVG: {}", e);
            } else {
                println!("Depth Map SVG export successful.");
            }
        } else {
            println!("DEBUG: Branch -> Profile SVG (Cut)");
            // Original logic for profile cut export
            if let Err(e) = generate_profile_svg(&request) {
                eprintln!("Error generating Profile SVG: {}", e);
            } else {
                println!("Profile SVG export successful.");
            }
        }
    } else if request.file_type == "DXF" {
        println!("DEBUG: Branch -> DXF");
        if let Err(e) = generate_dxf(&request) {
            eprintln!("Error generating DXF: {}", e);
        } else {
            println!("DXF export successful.");
        }
    }
}

// Evaluate cubic bezier at t
fn eval_bezier(p0: Coord<f64>, p1: Coord<f64>, p2: Coord<f64>, p3: Coord<f64>, t: f64) -> Coord<f64> {
    let mt = 1.0 - t;
    let mt2 = mt * mt;
    let mt3 = mt2 * mt;
    let t2 = t * t;
    let t3 = t2 * t;
    
    Coord {
        x: mt3 * p0.x + 3.0 * mt2 * t * p1.x + 3.0 * mt * t2 * p2.x + t3 * p3.x,
        y: mt3 * p0.y + 3.0 * mt2 * t * p1.y + 3.0 * mt * t2 * p2.y + t3 * p3.y,
    }
}

// Discretize open or generic path
fn discretize_path(points: &[ExportPoint]) -> LineString<f64> {
    let mut coords = Vec::new();
    if points.is_empty() { return LineString::new(vec![]); }

    coords.push(Coord { x: points[0].x, y: points[0].y });

    for i in 0..points.len() {
        if i >= points.len() - 1 { break; }

        let p0 = &points[i];
        let p3 = &points[i+1];
        
        // Check for handles
        let has_curve = p0.handle_out.is_some() || p3.handle_in.is_some();
        
        if has_curve {
            let cp1 = if let Some(h) = &p0.handle_out {
                Coord { x: p0.x + h.x, y: p0.y + h.y }
            } else {
                Coord { x: p0.x, y: p0.y }
            };
            
            let cp2 = if let Some(h) = &p3.handle_in {
                Coord { x: p3.x + h.x, y: p3.y + h.y }
            } else {
                Coord { x: p3.x, y: p3.y }
            };

            // Sample
            let steps = 16;
            for s in 1..=steps {
                let t = s as f64 / steps as f64;
                coords.push(eval_bezier(
                    Coord { x: p0.x, y: p0.y }, 
                    cp1, cp2, 
                    Coord { x: p3.x, y: p3.y }, 
                    t
                ));
            }
        } else {
            coords.push(Coord { x: p3.x, y: p3.y });
        }
    }
    
    LineString::new(coords)
}

// Special version for outline which is always closed
fn discretize_path_closed(points: &[ExportPoint]) -> LineString<f64> {
    if points.is_empty() { return LineString::new(vec![]); }
    let mut ls = discretize_path(points);
    
    // Add closing segment
    let last = &points[points.len() - 1];
    let first = &points[0];
    
    // Check if we need to discretize the closing segment
    let has_curve = last.handle_out.is_some() || first.handle_in.is_some();
    
    if has_curve {
        let cp1 = if let Some(h) = &last.handle_out {
            Coord { x: last.x + h.x, y: last.y + h.y }
        } else {
            Coord { x: last.x, y: last.y }
        };
        let cp2 = if let Some(h) = &first.handle_in {
            Coord { x: first.x + h.x, y: first.y + h.y }
        } else {
            Coord { x: first.x, y: first.y }
        };
        
        let steps = 16;
        for s in 1..=steps {
             let t = s as f64 / steps as f64;
             ls.0.push(eval_bezier(
                 Coord { x: last.x, y: last.y },
                 cp1, cp2,
                 Coord { x: first.x, y: first.y },
                 t
             ));
        }
    } else {
        ls.0.push(Coord { x: first.x, y: first.y });
    }
    ls
}

fn stroke_linestring(ls: &LineString<f64>, thickness: f64) -> Polygon<f64> {
    if ls.0.len() < 2 { return Polygon::new(LineString::new(vec![]), vec![]); }
    
    let half_t = thickness / 2.0;
    let mut left_pts = Vec::new();
    let mut right_pts = Vec::new();

    for i in 0..ls.0.len() {
        let p = ls.0[i];
        let tangent;
        
        if i == 0 {
            let next = ls.0[i+1];
            let dx = next.x - p.x;
            let dy = next.y - p.y;
            let len = (dx*dx + dy*dy).sqrt();
            tangent = Coord { x: dx/len, y: dy/len };
        } else if i == ls.0.len() - 1 {
            let prev = ls.0[i-1];
            let dx = p.x - prev.x;
            let dy = p.y - prev.y;
            let len = (dx*dx + dy*dy).sqrt();
            tangent = Coord { x: dx/len, y: dy/len };
        } else {
            let prev = ls.0[i-1];
            let next = ls.0[i+1];
            // Average tangent
            let dx1 = p.x - prev.x; let dy1 = p.y - prev.y;
            let dx2 = next.x - p.x; let dy2 = next.y - p.y;
            // normalize both
            let l1 = (dx1*dx1 + dy1*dy1).sqrt();
            let l2 = (dx2*dx2 + dy2*dy2).sqrt();
            let tx = dx1/l1 + dx2/l2;
            let ty = dy1/l1 + dy2/l2;
            let tl = (tx*tx + ty*ty).sqrt();
            tangent = Coord { x: tx/tl, y: ty/tl };
        }

        let normal = Coord { x: -tangent.y, y: tangent.x };
        
        left_pts.push(Coord { x: p.x + normal.x * half_t, y: p.y + normal.y * half_t });
        right_pts.push(Coord { x: p.x - normal.x * half_t, y: p.y - normal.y * half_t });
    }

    // Construct loop with Rounded Ends (Semicircles)
    // Left forward
    let mut loop_coords = left_pts.clone();
    
    // Tip Cap (Rounded): Rotate the normal vector CW 180 degrees at the end
    let p_last = ls.0[ls.0.len() - 1];
    let v_start = Coord { 
        x: left_pts.last().unwrap().x - p_last.x, 
        y: left_pts.last().unwrap().y - p_last.y 
    };
    
    let steps = 16;
    for i in 1..steps { 
        let theta = -(i as f64 / steps as f64) * PI; // CW rotation
        let cos_t = theta.cos();
        let sin_t = theta.sin();
        let vx = v_start.x * cos_t - v_start.y * sin_t;
        let vy = v_start.x * sin_t + v_start.y * cos_t;
        loop_coords.push(Coord { x: p_last.x + vx, y: p_last.y + vy });
    }

    // Right backward
    loop_coords.extend(right_pts.iter().rev().cloned());
    
    // Start Cap (Rounded): Rotate the normal vector CW 180 degrees at the start
    let p_first = ls.0[0];
    let v_start_cap = Coord {
        x: right_pts[0].x - p_first.x,
        y: right_pts[0].y - p_first.y
    };
    
    for i in 1..steps {
        let theta = -(i as f64 / steps as f64) * PI;
        let cos_t = theta.cos();
        let sin_t = theta.sin();
        let vx = v_start_cap.x * cos_t - v_start_cap.y * sin_t;
        let vy = v_start_cap.x * sin_t + v_start_cap.y * cos_t;
        loop_coords.push(Coord { x: p_first.x + vx, y: p_first.y + vy });
    }

    // Close
    if let Some(first) = loop_coords.first() {
        loop_coords.push(*first);
    }

    Polygon::new(LineString::new(loop_coords), vec![])
}

// -----------------------------------------------------------
//  EXPANSION LOGIC FOR GRADIENTS
// -----------------------------------------------------------

// Helper that produces an offset version of the shape (shrinks it inwards)
fn shape_to_polygon_offset(shape: &ExportShape, offset: f64) -> Option<Polygon<f64>> {
    // Modify a clone of the shape params
    let mut temp = shape.clone();
    
    match temp.shape_type.as_str() {
        "circle" => {
            if let Some(d) = temp.diameter {
                temp.diameter = Some(d - 2.0 * offset);
                if temp.diameter.unwrap() <= 1e-4 { return None; }
            }
        },
        "rect" => {
            if let Some(w) = temp.width { temp.width = Some(w - 2.0 * offset); }
            if let Some(h) = temp.height { temp.height = Some(h - 2.0 * offset); }
            if temp.width.unwrap_or(0.0) <= 1e-4 || temp.height.unwrap_or(0.0) <= 1e-4 { return None; }
            
            if let Some(cr) = temp.corner_radius {
                temp.corner_radius = Some((cr - offset).max(0.0));
            }
        },
        "line" => {
            if let Some(t) = temp.thickness {
                temp.thickness = Some(t - 2.0 * offset);
                if temp.thickness.unwrap() <= 1e-4 { return None; }
            }
        },
        _ => return None
    }
    
    shape_to_polygon(&temp)
}

// Expand a shape into multiple slices if it has a ball-nose radius
fn expand_ball_nose_shape(shape: &ExportShape) -> Vec<(Polygon<f64>, f64)> {
    let radius = shape.endmill_radius.unwrap_or(0.0);
    
    // Standard flat cut (no radius)
    if radius <= 1e-4 {
        if let Some(poly) = shape_to_polygon(shape) {
            return vec![(poly, shape.depth)];
        }
        return vec![];
    }
    
    // Safety: ensure radius isn't larger than the shape itself
    let min_dim = match shape.shape_type.as_str() {
        "circle" => shape.diameter.unwrap_or(0.0),
        "rect" => shape.width.unwrap_or(0.0).min(shape.height.unwrap_or(0.0)),
        "line" => shape.thickness.unwrap_or(0.0),
        _ => 0.0,
    };
    
    // Clamp radius
    let safe_radius = radius.min(shape.depth).min(min_dim / 2.0 - 0.001).max(0.0);
    
    // If effectively zero after safety check
    if safe_radius <= 1e-4 {
        if let Some(poly) = shape_to_polygon(shape) {
            return vec![(poly, shape.depth)];
        }
        return vec![];
    }

    let mut slices = Vec::new();
    let steps = 12; // Gradient fidelity (number of steps in the curve)

    // 1. Base Vertical Hole (Top of Fillet)
    // Depth: Total - Radius
    // Offset: 0 (Full width)
    let base_depth = shape.depth - safe_radius;
    if base_depth > 1e-4 {
        if let Some(poly) = shape_to_polygon_offset(shape, 0.0) {
            slices.push((poly, base_depth));
        }
    }

    // 2. Fillet Slices (Curving inwards to bottom)
    for i in 1..=steps {
        let ratio = i as f64 / steps as f64;
        let theta = ratio * std::f64::consts::FRAC_PI_2; // 0..90 deg
        
        // Z Depth increases from base_depth to shape.depth
        let z = base_depth + theta.sin() * safe_radius;
        
        // Offset increases from 0 to radius
        // Circular profile: offset = R - R*cos(theta)
        let offset = safe_radius * (1.0 - theta.cos());
        
        if let Some(poly) = shape_to_polygon_offset(shape, offset) {
            slices.push((poly, z));
        }
    }

    slices
}

// Helper to get raw polygon list for depth maps (no union), with EXPANSION logic
fn get_board_and_shapes_expanded(request: &ExportRequest) -> Option<(Polygon<f64>, Vec<(Polygon<f64>, f64)>)> {
    if request.outline.is_empty() { return None; }

    let board_ls = discretize_path_closed(&request.outline);
    let board_poly = Polygon::new(board_ls, vec![]);

    // Convert Shapes to List of (Polygon, Depth)
    let mut shape_list = Vec::new();

    for shape in &request.shapes {
        // Here we expand the shape into potential multiple slices
        let slices = expand_ball_nose_shape(shape);
        shape_list.extend(slices);
    }

    Some((board_poly, shape_list))
}

// Helper to partition semantic circles from those needing CSG unioning
fn partition_isolated_circles(request: &ExportRequest) -> (Polygon<f64>, Vec<ExportShape>, Vec<ExportShape>) {
    let board_ls = discretize_path_closed(&request.outline);
    let board_poly = Polygon::new(board_ls, vec![]);

    let mut isolated = Vec::new();
    let mut csg_pool = Vec::new();

    let shape_polys: Vec<(usize, Polygon<f64>)> = request.shapes.iter().enumerate()
        .filter_map(|(i, s)| shape_to_polygon(s).map(|p| (i, p)))
        .collect();

    for (i, shape) in request.shapes.iter().enumerate() {
        let mut is_isolated = false;
        if shape.shape_type == "circle" {
            if let Some(poly) = shape_to_polygon(shape) {
                let mut overlaps = false;
                for (other_idx, other_poly) in &shape_polys {
                    if i == *other_idx { continue; }
                    if poly.intersects(other_poly) { overlaps = true; break; }
                }
                if !overlaps && board_poly.contains(&poly) { is_isolated = true; }
            }
        }

        if is_isolated { isolated.push(shape.clone()); }
        else { csg_pool.push(shape.clone()); }
    }

    (board_poly, isolated, csg_pool)
}

// Helper to get unioned geometry for profile cuts from a specific pool
fn get_geometry_unioned_from_pool(board_poly: &Polygon<f64>, pool: &[ExportShape]) -> MultiPolygon<f64> {
    let board_sketch = Sketch::from_geo(geo::Geometry::Polygon(board_poly.clone()).into(), None);
    let mut united_sketch: Option<Sketch<()>> = None;

    for shape in pool {
        if let Some(poly) = shape_to_polygon(shape) {
            let shape_sketch = Sketch::from_geo(geo::Geometry::Polygon(poly).into(), None); 
            if let Some(current) = united_sketch {
                united_sketch = Some(current.union(&shape_sketch));
            } else {
                united_sketch = Some(shape_sketch);
            }
        }
    }
    
    if let Some(sketch) = united_sketch {
        let clipped_sketch = sketch.intersection(&board_sketch);
        let mut polys = Vec::new();
        for geom in clipped_sketch.geometry {
            match geom {
                geo::Geometry::Polygon(p) => polys.push(p),
                geo::Geometry::MultiPolygon(mp) => polys.extend(mp.0),
                _ => {}
            }
        }
        MultiPolygon::new(polys)
    } else {
        MultiPolygon::new(vec![])
    }
}

fn generate_profile_svg(request: &ExportRequest) -> Result<(), Box<dyn std::error::Error>> {
    println!("DEBUG: Starting generate_profile_svg...");
    let (board_poly_raw, isolated_circles, pool) = partition_isolated_circles(request);
    let united_shapes_raw = get_geometry_unioned_from_pool(&board_poly_raw, &pool);

    println!("DEBUG: Geometry generated. Outline valid. Shape count: {}", united_shapes_raw.0.len());

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

    println!("DEBUG: SVG Bounds - {} {} {} {}", min_x, min_y, width, height);

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

    // Isolated Circles (Parametric)
    for circle in isolated_circles {
        let r = circle.diameter.unwrap_or(0.0) / 2.0;
        let c_node = Circle::new()
            .set("cx", circle.x)
            .set("cy", -circle.y)
            .set("r", r)
            .set("fill", "none")
            .set("stroke", "red")
            .set("stroke-width", "0.1mm");
        document = document.add(c_node);
    }

    println!("DEBUG: Saving SVG to {}", request.filepath);
    svg::save(&request.filepath, &document)?;
    println!("DEBUG: SVG saved successfully.");

    Ok(())
}

fn generate_depth_map_svg(request: &ExportRequest) -> Result<(), Box<dyn std::error::Error>> {
    // UPDATED: Use expanded shape generator which handles ball-nose gradients
    let (board_poly_raw, shapes_raw) = match get_board_and_shapes_expanded(request) {
        Some(g) => g,
        None => return Ok(()),
    };

    // Prepare board sketch for math clipping
    let board_sketch = Sketch::from_geo(geo::Geometry::Polygon(board_poly_raw.clone()).into(), None);

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

    // A. Merge adjacent shapes with same depth AND clip them to board
    let mut layers: Vec<Layer> = Vec::new();
    for (poly_raw, depth) in shapes_raw {
        let geom = geo::Geometry::Polygon(poly_raw);
        // CLIP: Intersect each shape slice with the board outline before it enters the list
        let sketch = Sketch::from_geo(geom.into(), None).intersection(&board_sketch);

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
        let final_multipoly_raw = MultiPolygon::new(p_list);

        if !final_multipoly_raw.0.is_empty() {
            let mut shapes_data = Data::new();
            // Transform the geometry to SVG space here
            let final_multipoly = final_multipoly_raw.map_coords(transform);
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
    let (board_poly, isolated_circles, pool) = partition_isolated_circles(request);
    let united_shapes = get_geometry_unioned_from_pool(&board_poly, &pool);

    let mut file = File::create(&request.filepath)?;
    
    // Handle Management
    // AC1015 requires a logical hierarchy. We'll reserve low handles for system objects.
    let mut handle_counter = 0x30; // Start entity handles after system objects
    let mut next_handle = || {
        handle_counter += 1;
        format!("{:X}", handle_counter)
    };

    // Constant handles for the mandatory structural objects
    let h_root_dict = "10";
    let h_layout_dict = "11";
    let h_ms_br = "12"; // Model Space Block Record
    let h_ps_br = "13"; // Paper Space Block Record
    let h_ms_layout = "14"; // Model Space Layout Object
    let h_ps_layout = "15"; // Paper Space Layout Object

    // 1. HEADER SECTION
    writeln!(file, "  0\nSECTION\n  2\nHEADER")?;
    writeln!(file, "  9\n$ACADVER\n  1\nAC1015")?;    // Target DXF 2000
    writeln!(file, "  9\n$DWGCODEPAGE\n  3\nANSI_1252")?; // Essential for AC1015
    writeln!(file, "  9\n$INSUNITS\n 70\n4")?;       // Millimeters
    writeln!(file, "  9\n$MEASUREMENT\n 70\n1")?;    // Metric
    // $HANDSEED must be higher than the last handle used in the file
    writeln!(file, "  9\n$HANDSEED\n  5\nFFFF")?; 
    writeln!(file, "  0\nENDSEC")?;

    // 2. TABLES SECTION
    writeln!(file, "  0\nSECTION\n  2\nTABLES")?;
    
    // Block Record Table (Mandatory for AC1015)
    writeln!(file, "  0\nTABLE\n  2\nBLOCK_RECORD\n  5\n1\n100\nAcDbSymbolTable\n 70\n2")?;
    
    // Model Space Record
    writeln!(file, "  0\nBLOCK_RECORD\n  5\n{}\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*MODEL_SPACE", h_ms_br)?;
    writeln!(file, "340\n{}", h_ms_layout)?; // Pointer to Layout Object
    
    // Paper Space Record
    writeln!(file, "  0\nBLOCK_RECORD\n  5\n{}\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*PAPER_SPACE", h_ps_br)?;
    writeln!(file, "340\n{}", h_ps_layout)?; // Pointer to Layout Object
    
    writeln!(file, "  0\nENDTAB")?;
    
    // Minimal Layer Table
    writeln!(file, "  0\nTABLE\n  2\nLAYER\n  5\n2\n100\nAcDbSymbolTable\n 70\n2")?;
    writeln!(file, "  0\nLAYER\n  5\n16\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n0\n 70\n0\n 62\n7\n  6\nContinuous")?;
    writeln!(file, "  0\nENDTAB")?;
    
    writeln!(file, "  0\nENDSEC")?;

    // 3. BLOCKS SECTION
    // Definitions for the Model and Paper space containers
    writeln!(file, "  0\nSECTION\n  2\nBLOCKS")?;
    
    // Model Space Block Definition
    writeln!(file, "  0\nBLOCK\n  5\n17\n330\n{}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*MODEL_SPACE\n 70\n0\n 10\n0\n 20\n0\n 30\n0\n  3\n*MODEL_SPACE", h_ms_br)?;
    writeln!(file, "  0\nENDBLK\n  5\n18\n330\n{}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd", h_ms_br)?;
    
    // Paper Space Block Definition
    writeln!(file, "  0\nBLOCK\n  5\n19\n330\n{}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*PAPER_SPACE\n 70\n0\n 10\n0\n 20\n0\n 30\n0\n  3\n*PAPER_SPACE", h_ps_br)?;
    writeln!(file, "  0\nENDBLK\n  5\n1A\n330\n{}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd", h_ps_br)?;
    
    writeln!(file, "  0\nENDSEC")?;

    // 4. ENTITIES SECTION
    writeln!(file, "  0\nSECTION\n  2\nENTITIES")?;

    // Note: All entities in AC1015 should point to h_ms_br (Model Space) as owner
    write_dxf_polygon(&mut file, &board_poly, "OUTLINE", 7, h_ms_br, &mut next_handle)?;

    for poly in &united_shapes.0 {
        write_dxf_polygon(&mut file, poly, "CUTS", 1, h_ms_br, &mut next_handle)?;
    }

    for circle in isolated_circles {
        let r = circle.diameter.unwrap_or(0.0) / 2.0;
        writeln!(file, "  0\nCIRCLE")?;
        writeln!(file, "  5\n{}", next_handle())?;
        writeln!(file, "330\n{}", h_ms_br)?; 
        writeln!(file, "100\nAcDbEntity\n  8\nCUTS\n 62\n1\n100\nAcDbCircle")?;
        writeln!(file, " 10\n{:.4}\n 20\n{:.4}\n 30\n0.0", circle.x, circle.y)?;
        writeln!(file, " 40\n{:.4}", r)?;
    }

    writeln!(file, "  0\nENDSEC")?;

    // 5. OBJECTS SECTION (The critical addition for AC1015 compatibility)
    writeln!(file, "  0\nSECTION\n  2\nOBJECTS")?;
    
    // Root Dictionary
    writeln!(file, "  0\nDICTIONARY\n  5\n{}\n100\nAcDbDictionary\n  3\nACAD_LAYOUT", h_root_dict)?;
    writeln!(file, "350\n{}", h_layout_dict)?;
    
    // Layout Dictionary
    writeln!(file, "  0\nDICTIONARY\n  5\n{}\n330\n{}\n100\nAcDbDictionary", h_layout_dict, h_root_dict)?;
    writeln!(file, "  3\nModel\n350\n{}", h_ms_layout)?;
    writeln!(file, "  3\nLayout1\n350\n{}", h_ps_layout)?;
    
    // Model Space Layout Object
    writeln!(file, "  0\nLAYOUT\n  5\n{}\n330\n{}\n100\nAcDbPlotSettings\n100\nAcDbLayout", h_ms_layout, h_layout_dict)?;
    writeln!(file, "  1\nModel\n 70\n1\n 71\n0")?; // Layout name and flags
    writeln!(file, "330\n{}", h_ms_br)?; // Pointer back to Block Record (Bidirectional)

    // Paper Space Layout Object
    writeln!(file, "  0\nLAYOUT\n  5\n{}\n330\n{}\n100\nAcDbPlotSettings\n100\nAcDbLayout", h_ps_layout, h_layout_dict)?;
    writeln!(file, "  1\nLayout1\n 70\n1\n 71\n1")?;
    writeln!(file, "330\n{}", h_ps_br)?; // Pointer back to Block Record (Bidirectional)
    
    writeln!(file, "  0\nENDSEC")?;

    writeln!(file, "  0\nEOF")?;

    Ok(())
}

fn write_dxf_polygon(
    file: &mut File, 
    poly: &Polygon<f64>, 
    layer: &str, 
    color: i32, 
    owner: &str,
    next_handle: &mut dyn FnMut() -> String
) -> std::io::Result<()> {
    write_dxf_polyline(file, poly.exterior(), layer, color, owner, next_handle)?;
    for interior in poly.interiors() {
        write_dxf_polyline(file, interior, layer, color, owner, next_handle)?;
    }
    Ok(())
}

fn write_dxf_polyline(
    file: &mut File, 
    ls: &LineString<f64>, 
    layer: &str, 
    color: i32, 
    owner: &str,
    next_handle: &mut dyn FnMut() -> String
) -> std::io::Result<()> {
    let mut coords = &ls.0[..];
    if coords.is_empty() { return Ok(()); }
    
    if coords.len() > 1 && coords.first() == coords.last() {
        coords = &coords[..coords.len() - 1];
    }

    writeln!(file, "  0\nLWPOLYLINE")?;
    writeln!(file, "  5\n{}", next_handle())?;       // Unique Handle
    writeln!(file, "330\n{}", owner)?;               // Ownership link
    writeln!(file, "100\nAcDbEntity")?;             // Subclass marker
    writeln!(file, "  8\n{}", layer)?;
    writeln!(file, " 62\n{}", color)?;
    writeln!(file, "100\nAcDbPolyline")?;           // Class-specific marker
    writeln!(file, " 90\n{}", coords.len())?;
    writeln!(file, " 70\n1")?;                      // Flag 1 = Closed loop
    
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
            let r = shape.corner_radius.unwrap_or(0.0);

            // If radius is effectively 0, standard rect
            if r < 0.001 {
                let half_w = w / 2.0;
                let half_h = h / 2.0;
                let corners = vec![
                    (-half_w, -half_h),
                    (half_w, -half_h),
                    (half_w, half_h),
                    (-half_w, half_h),
                ];
                let rad = angle_deg.to_radians();
                let cos_a = rad.cos();
                let sin_a = rad.sin();
                let rotated_coords: Vec<Coord<f64>> = corners.iter().map(|(x, y)| {
                    Coord {
                        x: cx + (x * cos_a - y * sin_a),
                        y: cy + (x * sin_a + y * cos_a),
                    }
                }).collect();
                return Some(Polygon::new(LineString::new(rotated_coords), vec![]));
            }

            // Rounded Rect
            let steps_per_corner = 12;
            let mut coords = Vec::new();
            let half_w = w / 2.0;
            let half_h = h / 2.0;
            // Clamp radius
            let safe_r = r.min(half_w).min(half_h);

            // 4 quadrants
            let quadrants = vec![
                (half_w - safe_r, -half_h + safe_r, -std::f64::consts::FRAC_PI_2), // Bottom Right
                (half_w - safe_r, half_h - safe_r, 0.0), // Top Right
                (-half_w + safe_r, half_h - safe_r, std::f64::consts::FRAC_PI_2), // Top Left
                (-half_w + safe_r, -half_h + safe_r, PI), // Bottom Left
            ];

            for (qx, qy, start_angle) in quadrants {
                for i in 0..=steps_per_corner {
                     let theta = start_angle + (i as f64 / steps_per_corner as f64) * std::f64::consts::FRAC_PI_2;
                     coords.push((qx + safe_r * theta.cos(), qy + safe_r * theta.sin()));
                }
            }
            
            // Rotate and Translate
            let rad = angle_deg.to_radians();
            let cos_a = rad.cos();
            let sin_a = rad.sin();

            let final_coords: Vec<Coord<f64>> = coords.iter().map(|(x, y)| {
                Coord {
                    x: cx + (x * cos_a - y * sin_a),
                    y: cy + (x * sin_a + y * cos_a),
                }
            }).collect();

            Some(Polygon::new(LineString::new(final_coords), vec![]))
        },
        "circle" => {
            let d = shape.diameter.unwrap_or(0.0);
            let r = d / 2.0;
            let cx = shape.x;
            let cy = shape.y;
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
        "line" => {
            if let Some(pts) = &shape.points {
                 if pts.len() < 2 { return None; }
                 let thickness = shape.thickness.unwrap_or(1.0).max(0.001);
                 
                 // Discretize centerline
                 let center_ls = discretize_path(pts);
                 // Stroke
                 Some(stroke_linestring(&center_ls, thickness))
            } else {
                None
            }
        },
        "polygon" => {
            if let Some(pts) = &shape.points {
                 if pts.len() < 3 { return None; }
                 // Use discretize_path_closed to handle potential handles, 
                 // though dense polygons from JS usually have none.
                 let ls = discretize_path_closed(pts);
                 Some(Polygon::new(ls, vec![]))
            } else {
                None
            }
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

#[command]
async fn compute_smart_split(input: GeometryInput) -> Result<geometry::OptimizationResult, String> {
    // Run CPU intensive task on a thread to avoid blocking UI
    let result = std::thread::spawn(move || {
        run_optimization(input)
    }).join().map_err(|_| "Optimization thread panicked".to_string())?;

    Ok(result)
}

#[command]
async fn get_debug_eval(input: GeometryInput) -> Result<String, String> {
    // Run CPU intensive task on a thread to avoid blocking UI
    let result = std::thread::spawn(move || {
        debug_split_eval(input)
    }).join().map_err(|_| "Eval panicked".to_string())?;

    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Initialize the plugins here
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![export_layer_files, compute_smart_split, get_debug_eval ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}