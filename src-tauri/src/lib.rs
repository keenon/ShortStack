// src-tauri/src/lib.rs
use tauri::command;
use tauri_plugin_shell::ShellExt;
use std::f64::consts::PI;
use geo::{Coord, LineString, MultiPolygon, Polygon};
use geo::BooleanOps;
use geo::bounding_rect::BoundingRect;
use geo::MapCoords;
use svg::Document;
use svg::node::element::{Path, Rectangle};
use svg::node::element::path::Data;
use std::fs::File;
use std::io::Write;

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
    } else if request.file_type == "STEP" {
        if let Err(e) = generate_step(&request) {
            eprintln!("Error generating STEP: {}", e);
        } else {
            println!("STEP export successful.");
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

    // 2. Convert Shapes to MultiPolygon and Union
    let mut united_shapes: MultiPolygon<f64> = MultiPolygon::new(vec![]);

    for shape in &request.shapes {
        if let Some(poly) = shape_to_polygon(shape) {
            let mp = MultiPolygon::new(vec![poly]);
            if united_shapes.0.is_empty() {
                united_shapes = mp;
            } else {
                united_shapes = united_shapes.union(&mp);
            }
        }
    }
    
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
    
    // Expand bounds slightly if shapes go outside? Usually board defines material. 
    // We stick to board bounds for the viewbox to align with material.
    
    let min_x = bounds.min().x;
    let min_y = bounds.min().y;
    let width = bounds.width();
    let height = bounds.height();

    let mut document = Document::new()
        .set("viewBox", format!("{} {} {} {}", min_x, min_y, width, height))
        .set("width", format!("{}mm", width))
        .set("height", format!("{}mm", height))
        .set("xmlns", "http://www.w3.org/2000/svg")
        .set("style", "background-color: black"); // Explicit CSS background just in case

    // 1. Background Black Rectangle (100% Cut / Empty Space)
    // We make it cover the entire ViewBox area.
    let bg_rect = Rectangle::new()
        .set("x", min_x)
        .set("y", min_y)
        .set("width", width)
        .set("height", height)
        .set("fill", "black");
    document = document.add(bg_rect);

    // 2. Board Solid White (0% Cut / Material Surface)
    // The board outline defines where material exists.
    let board_data = polygon_to_path_data(&board_poly);
    let board_path = Path::new()
        .set("fill", "white")
        .set("stroke", "none") 
        .set("d", board_data);
    document = document.add(board_path);

    // 3. Individual Shapes (Grayscale Depth)
    // Shapes are already ordered by the frontend to match visual stack.
    // We iterate and draw them.
    for (poly_raw, depth) in shapes_raw {
        let poly = poly_raw.map_coords(transform);
        let path_data = polygon_to_path_data(&poly);
        
        // Calculate Color
        // Ratio = depth / thickness
        // 0% Depth = White (255)
        // 100% Depth = Black (0)
        let mut ratio = depth / request.layer_thickness;
        if ratio < 0.0 { ratio = 0.0; }
        if ratio > 1.0 { ratio = 1.0; }

        let val = (255.0 * (1.0 - ratio)).round() as u8;
        let color = format!("rgb({},{},{})", val, val, val);

        let shape_path = Path::new()
            .set("fill", color)
            .set("stroke", "none")
            .set("d", path_data);
        document = document.add(shape_path);
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

fn generate_step(request: &ExportRequest) -> Result<(), Box<dyn std::error::Error>> {
    let mut writer = StepWriter::new(&request.filepath)?;
    writer.write_header()?;

    let mut solids = Vec::new();

    if request.machining_type == "Carved/Printed" {
        // Carved mode: Export Board as Solid + Cuts as overlapping Solids
        if let Some((board_poly, shapes)) = get_board_and_shapes_raw(request) {
            // 1. Board Solid (0 to thickness)
            let board_id = writer.write_extrusion(&board_poly, 0.0, request.layer_thickness, "Board")?;
            solids.push(board_id);

            // 2. Shape Solids
            for (i, (poly, depth)) in shapes.iter().enumerate() {
                // Determine Z range
                let (z_min, z_max) = if request.cut_direction == "Bottom" {
                    // Bottom cut: Z=0 up to Z=depth
                    (0.0, *depth)
                } else {
                    // Top cut: Z=thickness down to Z=thickness-depth
                    (request.layer_thickness - *depth, request.layer_thickness)
                };

                if (z_max - z_min).abs() < 1e-6 {
                    continue;
                }

                let name = format!("Cut_{}", i);
                let shape_id = writer.write_extrusion(poly, z_min, z_max, &name)?;
                solids.push(shape_id);
            }
        }
    } else {
        // Cut mode (Profile): Export single solid with holes
        if let Some((board_poly, united_shapes)) = get_geometry_unioned(request) {
            // Perform 2D Boolean Difference
            let result_mp: MultiPolygon<f64> = board_poly.difference(&united_shapes);
            
            for (i, poly) in result_mp.0.iter().enumerate() {
                let name = format!("Part_{}", i);
                let id = writer.write_extrusion(poly, 0.0, request.layer_thickness, &name)?;
                solids.push(id);
            }
        }
    }

    writer.write_product_structure(solids)?;

    Ok(())
}

struct StepWriter {
    file: File,
    next_id: usize,
}

impl StepWriter {
    fn new(path: &str) -> std::io::Result<Self> {
        let file = File::create(path)?;
        Ok(Self { file, next_id: 0 })
    }

    fn get_id(&mut self) -> usize {
        self.next_id += 1;
        self.next_id
    }

    fn write_header(&mut self) -> std::io::Result<()> {
        writeln!(self.file, "ISO-10303-21;")?;
        writeln!(self.file, "HEADER;")?;
        writeln!(self.file, "FILE_DESCRIPTION(('SimpleCAD Export'), '2;1');")?;
        writeln!(self.file, "FILE_NAME('export.step', '2025-01-01', ('User'), ('System'), 'SimpleCAD', 'SimpleCAD', '');")?;
        writeln!(self.file, "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));")?; // AP203
        writeln!(self.file, "ENDSEC;")?;
        writeln!(self.file, "DATA;")?;
        Ok(())
    }

    fn write_cartesian_point(&mut self, x: f64, y: f64, z: f64) -> std::io::Result<usize> {
        let id = self.get_id();
        writeln!(self.file, "#{}=CARTESIAN_POINT('',({:.6},{:.6},{:.6}));", id, x, y, z)?;
        Ok(id)
    }

    fn write_poly_loop(&mut self, points: &[usize]) -> std::io::Result<usize> {
        let id = self.get_id();
        write!(self.file, "#{}=POLY_LOOP('',(", id)?;
        for (i, p_id) in points.iter().enumerate() {
            if i > 0 { write!(self.file, ",")?; }
            write!(self.file, "#{}", p_id)?;
        }
        writeln!(self.file, "));")?;
        Ok(id)
    }

    fn write_face_bound(&mut self, loop_id: usize, is_outer: bool) -> std::io::Result<usize> {
        let id = self.get_id();
        let entity = if is_outer { "FACE_OUTER_BOUND" } else { "FACE_BOUND" };
        let rep_item_id = self.get_id();
        writeln!(self.file, "#{}=MASTER_TOPOLOGICAL_REPRESENTATION_ITEM('',#{});", rep_item_id, loop_id)?; 
        writeln!(self.file, "#{0}={1}('',#{2},.T.);", id, entity, loop_id)?;
        Ok(id)
    }

    fn write_simple_face(&mut self, bounds: &[usize]) -> std::io::Result<usize> {
        let id = self.get_id();
        write!(self.file, "#{}=FACE('',(", id)?;
        for (i, b_id) in bounds.iter().enumerate() {
            if i > 0 { write!(self.file, ",")?; }
            write!(self.file, "#{}", b_id)?;
        }
        writeln!(self.file, "));")?;
        Ok(id)
    }

    fn write_closed_shell(&mut self, faces: &[usize]) -> std::io::Result<usize> {
        let id = self.get_id();
        write!(self.file, "#{}=CLOSED_SHELL('',(", id)?;
        for (i, f_id) in faces.iter().enumerate() {
            if i > 0 { write!(self.file, ",")?; }
            write!(self.file, "#{}", f_id)?;
        }
        writeln!(self.file, "));")?;
        Ok(id)
    }

    fn write_faceted_brep(&mut self, name: &str, shell_id: usize) -> std::io::Result<usize> {
        let id = self.get_id();
        writeln!(self.file, "#{}=FACETED_BREP('{}',#{});", id, name, shell_id)?;
        Ok(id)
    }

    // New helper method to avoid closure borrow issues
    fn write_poly_loop_from_linestring(&mut self, ls: &LineString<f64>, z: f64, reverse: bool) -> std::io::Result<(usize, Vec<usize>)> {
        let mut pt_ids = Vec::new();
        let coords = &ls.0;
        let len = if !coords.is_empty() && coords.first() == coords.last() {
            coords.len() - 1
        } else {
            coords.len()
        };

        for i in 0..len {
            let idx = if reverse { len - 1 - i } else { i };
            let c = coords[idx];
            pt_ids.push(self.write_cartesian_point(c.x, c.y, z)?);
        }
        let loop_id = self.write_poly_loop(&pt_ids)?;
        Ok((loop_id, pt_ids))
    }

    fn write_extrusion(&mut self, poly: &Polygon<f64>, z_min: f64, z_max: f64, name: &str) -> std::io::Result<usize> {
        let mut faces = Vec::new();
        
        // 1. Bottom Face (z_min) - Exterior Reversed (CW)
        let mut bottom_bounds = Vec::new();
        
        // Exterior
        let (b_out_loop, _) = self.write_poly_loop_from_linestring(poly.exterior(), z_min, true)?; 
        let b_out_bound = self.write_face_bound(b_out_loop, true)?;
        bottom_bounds.push(b_out_bound);

        // Interiors
        for interior in poly.interiors() {
            // Interiors Reversed (CCW)
            let (b_in_loop, _) = self.write_poly_loop_from_linestring(interior, z_min, true)?; 
            let b_in_bound = self.write_face_bound(b_in_loop, false)?;
            bottom_bounds.push(b_in_bound);
        }
        faces.push(self.write_simple_face(&bottom_bounds)?);

        // 2. Top Face (z_max) - Exterior Normal (CCW)
        let mut top_bounds = Vec::new();
        
        // Exterior
        let (t_out_loop, _) = self.write_poly_loop_from_linestring(poly.exterior(), z_max, false)?; 
        let t_out_bound = self.write_face_bound(t_out_loop, true)?;
        top_bounds.push(t_out_bound);

        // Interiors
        for interior in poly.interiors() {
            // Interiors Normal (CW)
            let (t_in_loop, _) = self.write_poly_loop_from_linestring(interior, z_max, false)?;
            let t_in_bound = self.write_face_bound(t_in_loop, false)?;
            top_bounds.push(t_in_bound);
            
            // Side Faces for Interior (Holes)
            let coords = &interior.0;
            let len = if !coords.is_empty() && coords.first() == coords.last() { coords.len() - 1 } else { coords.len() };
            
            for i in 0..len {
                let p1 = coords[i];
                let p2 = coords[(i + 1) % len];
                
                let pt1 = self.write_cartesian_point(p1.x, p1.y, z_max)?;
                let pt2 = self.write_cartesian_point(p1.x, p1.y, z_min)?;
                let pt3 = self.write_cartesian_point(p2.x, p2.y, z_min)?;
                let pt4 = self.write_cartesian_point(p2.x, p2.y, z_max)?;
                
                let loop_id = self.write_poly_loop(&[pt1, pt2, pt3, pt4])?;
                let bound_id = self.write_face_bound(loop_id, true)?;
                faces.push(self.write_simple_face(&[bound_id])?);
            }
        }
        faces.push(self.write_simple_face(&top_bounds)?);

        // 3. Side Faces for Exterior
        let coords = &poly.exterior().0;
        let len = if !coords.is_empty() && coords.first() == coords.last() { coords.len() - 1 } else { coords.len() };
        for i in 0..len {
            let p1 = coords[i];
            let p2 = coords[(i + 1) % len];
            
            let pt1 = self.write_cartesian_point(p1.x, p1.y, z_max)?;
            let pt2 = self.write_cartesian_point(p1.x, p1.y, z_min)?;
            let pt3 = self.write_cartesian_point(p2.x, p2.y, z_min)?;
            let pt4 = self.write_cartesian_point(p2.x, p2.y, z_max)?;
            
            let loop_id = self.write_poly_loop(&[pt1, pt2, pt3, pt4])?;
            let bound_id = self.write_face_bound(loop_id, true)?;
            faces.push(self.write_simple_face(&[bound_id])?);
        }

        let shell_id = self.write_closed_shell(&faces)?;
        self.write_faceted_brep(name, shell_id)
    }

    fn write_product_structure(&mut self, shape_ids: Vec<usize>) -> std::io::Result<()> {
        // Basic Context
        let ctx_id = self.get_id();
        writeln!(self.file, "#{}=GEOMETRIC_REPRESENTATION_CONTEXT(3);", ctx_id)?;

        // Shape Representation containing all solids
        let rep_id = self.get_id();
        write!(self.file, "#{}=ADVANCED_BREP_SHAPE_REPRESENTATION('Exported Model',(", rep_id)?;
        for (i, id) in shape_ids.iter().enumerate() {
            if i > 0 { write!(self.file, ",")?; }
            write!(self.file, "#{}", id)?;
        }
        writeln!(self.file, "),#{});", ctx_id)?;

        // Product Definition Structure (Minimal)
        let product_id = self.get_id();
        writeln!(self.file, "#{}=PRODUCT('Product','Product','',(#{}));", product_id, ctx_id)?; // Simplified
        
        let app_proto = self.get_id();
        writeln!(self.file, "#{}=APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',2003,#0);", app_proto)?;
        
        let p_def_context = self.get_id();
        writeln!(self.file, "#{}=APPLICATION_CONTEXT('automotive_design');", p_def_context)?; 
        
        let p_context = self.get_id();
        writeln!(self.file, "#{}=PRODUCT_CONTEXT('',#{},'mechanical');", p_context, p_def_context)?;
        
        let product = self.get_id();
        writeln!(self.file, "#{}=PRODUCT('Part','Part','Part',(#{}));", product, p_context)?;
        
        let p_def_formation = self.get_id();
        writeln!(self.file, "#{}=PRODUCT_DEFINITION_FORMATION('','',#{});", p_def_formation, product)?;
        
        let p_def = self.get_id();
        writeln!(self.file, "#{}=PRODUCT_DEFINITION('design','',#{},#{});", p_def, p_def_formation, p_context)?;
        
        let p_def_shape = self.get_id();
        writeln!(self.file, "#{}=PRODUCT_DEFINITION_SHAPE('','',#{});", p_def_shape, p_def)?;
        
        let shape_def_rep = self.get_id();
        writeln!(self.file, "#{}=SHAPE_DEFINITION_REPRESENTATION(#{},#{});", shape_def_rep, p_def_shape, rep_id)?;

        writeln!(self.file, "ENDSEC;")?;
        writeln!(self.file, "END-ISO-10303-21;")?;
        Ok(())
    }
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