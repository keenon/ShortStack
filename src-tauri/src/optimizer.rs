use crate::geometry::*;
use cmaes::{CMAESOptions, DVector, PlotOptions};
use geo::{Point, LineString, Polygon, Euclidean, Distance};
use std::f64::consts::PI;

const OBS_MARGIN: f64 = 2.0;
const MIN_W: f64 = 5.0;
const MAX_W: f64 = 25.0;
const MIN_H: f64 = 4.0;
const MAX_H: f64 = 12.0;

struct DovetailShape { 
    t: f64, 
    w: f64, 
    h: f64, 
    flipped: bool // Added this
}

#[derive(serde::Serialize)]
pub struct DebugEvalResult {
    log: String,
    cost: f64,
    points_a: Vec<[f64; 2]>,
    points_b: Vec<[f64; 2]>,
}

#[derive(Clone)] // Added Clone
struct CostContext {
    outline: Vec<Point<f64>>,
    obstacles: Vec<Obstacle>,
    bed_w: f64,
    bed_h: f64,
    center: Point<f64>,
    radius: f64,
}

fn line_to_params(start: [f64; 2], end: [f64; 2], ctx: &CostContext) -> (f64, f64, f64) {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    
    // 1. Calculate Angle (0 to PI)
    let mut angle = dy.atan2(dx); 
    if angle < 0.0 { angle += PI; }
    if angle >= PI { angle -= PI; }
    let angle_norm = angle / PI;

    // 2. Unit Vectors
    let ux = angle.cos();
    let uy = angle.sin();
    
    // Position Normal (Standardized)
    let nx = -uy; 
    let ny = ux;

    // 3. Offset
    let line_proj = start[0] * nx + start[1] * ny;
    let center_proj = ctx.center.x() * nx + ctx.center.y() * ny;
    let offset_dist = line_proj - center_proj;
    let offset_norm = (offset_dist / ctx.radius) * 0.5 + 0.5;

    // 4. Longitudinal Position (t)
    // We need to map the user's line midpoint to the 't' parameter (0..1)
    // relative to the board intersection.
    
    // Anchor point used by decode_params
    let anchor_x = ctx.center.x() + nx * (offset_dist);
    let anchor_y = ctx.center.y() + ny * (offset_dist);

    // Calculate extents of the board outline projected onto this infinite line
    let mut min_t = f64::MAX;
    let mut max_t = f64::MIN;
    for p in &ctx.outline {
        let t = (p.x() - anchor_x) * ux + (p.y() - anchor_y) * uy;
        min_t = min_t.min(t);
        max_t = max_t.max(t);
    }

    // User's midpoint
    let user_mid_x = (start[0] + end[0]) / 2.0;
    let user_mid_y = (start[1] + end[1]) / 2.0;
    
    // Project user midpoint onto the line relative to anchor
    let user_t_raw = (user_mid_x - anchor_x) * ux + (user_mid_y - anchor_y) * uy;
    
    // Normalize based on board extents
    let mut geometric_t = 0.5;
    if (max_t - min_t).abs() > 1e-6 {
        geometric_t = (user_t_raw - min_t) / (max_t - min_t);
    }

    let t_seed = (geometric_t - 0.1) / 0.8;
    (angle_norm.clamp(0.0, 1.0), offset_norm.clamp(0.0, 1.0), t_seed.clamp(0.0, 1.0))
}

pub fn run_optimization(input: GeometryInput) -> OptimizationResult {
    // Convert Input to Geo Types & Precompute center
    let poly_points: Vec<Point<f64>> = input.outline.iter().map(|p| Point::new(p[0], p[1])).collect();
    
    // Compute centroid/radius for normalizing inputs
    let mut min_x = f64::MAX; let mut max_x = f64::MIN;
    let mut min_y = f64::MAX; let mut max_y = f64::MIN;
    for p in &poly_points {
        min_x = min_x.min(p.x()); max_x = max_x.max(p.x());
        min_y = min_y.min(p.y()); max_y = max_y.max(p.y());
    }
    let center = Point::new((min_x + max_x)/2.0, (min_y + max_y)/2.0);
    let radius = ((max_x - min_x).powi(2) + (max_y - min_y).powi(2)).sqrt() / 2.0;

    let ctx = CostContext {
        outline: poly_points,
        obstacles: input.obstacles,
        bed_w: input.bed_width,
        bed_h: input.bed_height,
        center,
        radius,
    };

    // 1. Generate Structured Seeds
    // The optimization landscape is full of local optima (dovetails stuck in holes).
    // Instead of one giant run, we do many fast runs starting from different angles/offsets.
    let mut seeds = Vec::new();

    if let Some(line) = input.initial_line {
        let (a_norm, o_norm, t_seed) = line_to_params(line[0], line[1], &ctx);
        
        // 1. Trust the Input Seed (Highest priority)
        // Sigma 0.1: Allows fine-tuning but keeps the line mostly where it is.
        seeds.push((vec![a_norm, o_norm, t_seed, 0.5, 0.5], 0.1));

        // 2. Longitudinal Grid Search (Targeted Restarts)
        // We trust the Angle/Offset (the "Cut Line"), but the dovetail position (T)
        // is highly sensitive to obstacles. We scan the entire length of the line.
        let t_steps = vec![0.15, 0.30, 0.45, 0.60, 0.75, 0.90];
        
        // We also try two different dovetail widths (Thin vs Thick) to help fit into gaps.
        let w_steps = vec![0.3, 0.7]; 

        for t in t_steps {
            for w in &w_steps {
                // Restart with Angle/Offset fixed to input, but T/W varied.
                // Sigma 0.05: Very tight on Angle/Offset to preserve the user's trajectory choice,
                // while allowing T/W to converge locally from this new basin.
                seeds.push((vec![a_norm, o_norm, t, *w, 0.5], 0.1));
            }
        }
    } else {
        // Fallback global search if no line provided
        seeds.push((vec![0.5, 0.5, 0.5, 0.5, 0.5], 0.2));
        for i in 0..4 {
            seeds.push((vec![i as f64/4.0, 0.5, 0.5, 0.5, 0.5], 0.2));
        }
    }

    let mut best_overall_cost = f64::MAX;
    let mut best_overall_cut: Option<GeneratedCut> = None;

    // Run Optimization on all seeds
    for flip_state in [false, true] {
        for (seed_vec, run_sigma) in &seeds {
            
            let ctx_clone = ctx.clone();
            
            // Fast CMA-ES settings: 
            // - Population 40: Enough to optimize 5 dimensions
            // - Generations 200: Enough to converge local basin
            let mut cmaes_state = CMAESOptions::new(seed_vec.clone(), *run_sigma)
                .population_size(40)
                .max_generations(200)
                .enable_printing(1000)
                .build(move |x: &DVector<f64>| evaluate_cost(x, &ctx_clone, flip_state))
                .unwrap();

            let result = cmaes_state.run();

            if let Some(best) = result.overall_best {
                if best.value < best_overall_cost {
                    best_overall_cost = best.value;
                    
                    let (_, p1, p2, dt) = decode_params(&best.point, &ctx, flip_state);
                    best_overall_cut = Some(GeneratedCut {
                        id: uuid::Uuid::new_v4().to_string(),
                        start: [p1.x(), p1.y()],
                        end: [p2.x(), p2.y()],
                        dovetail_width: dt.w,
                        dovetail_height: dt.h,
                        dovetail_t: dt.t,
                        flipped: flip_state,
                    });
                }
            }

            // Early Exit: If we found a valid solution, stop trying seeds for this flip state.
            // Cost < 1.0 means no collisions and good fit.
            if best_overall_cost < 1.0 { break; }
        }
        
        // Global Early Exit: If valid solution found, don't even check flipped state (unless we want to optimize further?)
        // Let's optimize for speed: if it fits, it sits.
        if best_overall_cost < 1.0 { break; }
    }

    match best_overall_cut {
        Some(cut) => OptimizationResult {
            success: best_overall_cost < 1.0,
            cost: best_overall_cost,
            shapes: vec![cut],
        },
        None => OptimizationResult { success: false, cost: f64::MAX, shapes: vec![] }
    }
}

fn decode_params(
    x: &DVector<f64>, 
    ctx: &CostContext, 
    flipped: bool // Passed in from loop
) -> (f64, Point<f64>, Point<f64>, DovetailShape) {
    let safe_x: Vec<f64> = x.iter().map(|v| v.clamp(0.0, 1.0)).collect();

    let angle = safe_x[0] * PI;
    let offset_norm = (safe_x[1] - 0.5) * 2.0;
    
    let ux = angle.cos();
    let uy = angle.sin();
    
    // Normal vector logic matching your TypeScript:
    // const px = flip ? uy : -uy;
    // const py = flip ? -ux : ux;
    // FIX: Decouple Position Normal from Dovetail Direction.
    // We always use the standard normal (-uy, ux) for positioning the Anchor.
    // This ensures that the 'offset' parameter represents the same physical location
    // regardless of whether we are flipping the dovetail direction.
    let nx = -uy;
    let ny = ux;

    let anchor = Point::new(
        ctx.center.x() + nx * (offset_norm * ctx.radius),
        ctx.center.y() + ny * (offset_norm * ctx.radius)
    );

    // We use the flip flag ONLY to determine which way the dovetail grows relative to the line.
    let (vx, vy) = if flipped {
        (uy, -ux)
    } else {
        (-uy, ux)
    };
    
    let mut min_t = f64::MAX;
    let mut max_t = f64::MIN;
    for p in &ctx.outline {
        let t = (p.x() - anchor.x()) * ux + (p.y() - anchor.y()) * uy;
        min_t = min_t.min(t);
        max_t = max_t.max(t);
    }
    
    let p1 = Point::new(anchor.x() + ux * min_t, anchor.y() + uy * min_t);
    let p2 = Point::new(anchor.x() + ux * max_t, anchor.y() + uy * max_t);

    let t_val = 0.1 + safe_x[2] * 0.8;
    let w_val = MIN_W + safe_x[3] * (MAX_W - MIN_W);
    let h_val = MIN_H + safe_x[4] * (MAX_H - MIN_H);

    (angle, p1, p2, DovetailShape { t: t_val, w: w_val, h: h_val, flipped })
}

// Wrapper for optimizer
fn evaluate_cost(x: &DVector<f64>, ctx: &CostContext, flipped: bool) -> f64 {
    evaluate_cost_detailed(x, ctx, flipped).0
}

// Detailed cost breakdown for debugging
fn evaluate_cost_detailed(x: &DVector<f64>, ctx: &CostContext, flipped: bool) -> (f64, String, Vec<[f64; 2]>, Vec<[f64; 2]>) {
    let mut cost = 0.0;
    let mut log = Vec::new();

    // 1. Parameter Constraints
    for (i, val) in x.iter().enumerate() {
        if *val < 0.0 { 
            let p = val.powi(2) * 1000.0;
            cost += p; 
            log.push(format!("Param {} < 0: +{:.2}", i, p));
        }
        if *val > 1.0 { 
            let p = (*val - 1.0).powi(2) * 1000.0;
            cost += p; 
            log.push(format!("Param {} > 1: +{:.2}", i, p));
        }
    }

    let (angle, p1, p2, dt) = decode_params(x, ctx, flipped);
    let ux = angle.cos();
    let uy = angle.sin();
    
    // Normal vector logic
    let (vx, vy) = if flipped { (uy, -ux) } else { (-uy, ux) };

    let center = Point::new(
        p1.x() + (p2.x() - p1.x()) * dt.t,
        p1.y() + (p2.y() - p1.y()) * dt.t
    );

    let base_half = dt.w / 2.0;
    let head_half = (dt.w * 1.5) / 2.0; 
    
    let base_l = Point::new(center.x() - ux * base_half, center.y() - uy * base_half);
    let base_r = Point::new(center.x() + ux * base_half, center.y() + uy * base_half);
    let head_l = Point::new(center.x() - ux * head_half + vx * dt.h, center.y() - uy * head_half + vy * dt.h);
    let head_r = Point::new(center.x() + ux * head_half + vx * dt.h, center.y() + uy * head_half + vy * dt.h);

    let cut_path = vec![(p1, base_l), (base_l, head_l), (head_l, head_r), (head_r, base_r), (base_r, p2)];

    // 2. Obstacle Check
    for (i, obs) in ctx.obstacles.iter().enumerate() {
        let obs_p = Point::new(obs.x, obs.y);
        let mut min_dist = f64::MAX;
        for (s, e) in &cut_path {
            min_dist = min_dist.min(dist_point_segment(obs_p, *s, *e));
        }
        let safe_dist = obs.r + OBS_MARGIN;
        if min_dist < safe_dist {
            let pen = (safe_dist - min_dist).powi(2) * 5000.0;
            cost += pen;
            log.push(format!("Obstacle {} @ ({:.2}, {:.2}) r={:.2} collision (dist {:.2} < {:.2}): +{:.2}", 
                            i, obs.x, obs.y, obs.r, min_dist, safe_dist, pen));        }
    }

    if cost > 100.0 { 
        return (cost, format!("High Cost Exit ({:.2}):\\n{}", cost, log.join("\\n")), vec![], vec![]);
    }

    // 3. Fit Check
    let c_val = p1.x() * vx + p1.y() * vy;
    let mut pts_a = Vec::new(); 
    let mut pts_b = Vec::new(); 

    let protrusion = vec![base_l, head_l, head_r, base_r];
    pts_a.extend_from_slice(&protrusion);

    for p in &ctx.outline {
        let val = p.x() * vx + p.y() * vy;
        if val >= c_val - 0.5 { pts_a.push(*p); }
        if val <= c_val + 0.5 { pts_b.push(*p); }
    }

    // FIX: Instead of pushing the infinite line endpoints (p1, p2) which might be 
    // far outside the board, we calculate exact intersections with the outline.
    // This ensures the Convex Hull is tight to the actual board geometry.
    let mut intersections_found = false;
    for i in 0..ctx.outline.len() {
        let o1 = ctx.outline[i];
        let o2 = ctx.outline[(i + 1) % ctx.outline.len()];
        if let Some(int_pt) = get_intersection(p1, p2, o1, o2) {
            pts_a.push(int_pt);
            pts_b.push(int_pt);
            intersections_found = true;
        }
    }
    
    // Fallback: If no intersections (e.g. line is exactly on edge or floating), 
    // keep p1/p2 to ensure we have a shape, though this case implies a bad cut.
    if !intersections_found {
        pts_a.push(p1); pts_a.push(p2);
        pts_b.push(p1); pts_b.push(p2);
    }

    // --- DEBUG: Geometry Inspection ---
    // Helper to log bounds and formatted points
    let inspect_part = |pts: &Vec<Point<f64>>, name: &str| -> String {
        let min_x = pts.iter().fold(f64::INFINITY, |a, b| a.min(b.x()));
        let max_x = pts.iter().fold(f64::NEG_INFINITY, |a, b| a.max(b.x()));
        let min_y = pts.iter().fold(f64::INFINITY, |a, b| a.min(b.y()));
        let max_y = pts.iter().fold(f64::NEG_INFINITY, |a, b| a.max(b.y()));
        
        let points_str: Vec<String> = pts.iter().map(|p| format!("[{:.1},{:.1}]", p.x(), p.y())).collect();
        
        format!("{}: Count={}, Size={:.1}x{:.1} (Bounds: {:.1},{:.1} to {:.1},{:.1})\\nPoints: [{}]", 
            name, pts.len(), max_x - min_x, max_y - min_y, min_x, min_y, max_x, max_y, points_str.join(", "))
    };

    let fit_pen_a = check_fit(&pts_a, ctx.bed_w, ctx.bed_h) * 10.0;
    let fit_pen_b = check_fit(&pts_b, ctx.bed_w, ctx.bed_h) * 10.0;
    
    if fit_pen_a > 0.0 || fit_pen_b > 0.0 {
        log.push(format!("Bed Size: {:.1} x {:.1}", ctx.bed_w, ctx.bed_h));
        log.push(format!("Cut Line: [{:.1},{:.1}] to [{:.1},{:.1}]", p1.x(), p1.y(), p2.x(), p2.y()));
    }

    if fit_pen_a > 0.0 { 
        log.push(format!("Part A Penalty +{:.2}. Details: {}", fit_pen_a, inspect_part(&pts_a, "Part A"))); 
    }
    if fit_pen_b > 0.0 { 
        log.push(format!("Part B Penalty +{:.2}. Details: {}", fit_pen_b, inspect_part(&pts_b, "Part B"))); 
    }

    cost += fit_pen_a + fit_pen_b;
    
    let raw_a = pts_a.iter().map(|p| [p.x(), p.y()]).collect();
    let raw_b = pts_b.iter().map(|p| [p.x(), p.y()]).collect();

    (cost, format!("Total: {:.2}\\n{}", cost, log.join("\\n")), raw_a, raw_b)
}


pub fn debug_split_eval(input: GeometryInput) -> DebugEvalResult {
    // Reconstruct Context
    let poly_points: Vec<Point<f64>> = input.outline.iter().map(|p| Point::new(p[0], p[1])).collect();
    let mut min_x = f64::MAX; let mut max_x = f64::MIN;
    let mut min_y = f64::MAX; let mut max_y = f64::MIN;
    for p in &poly_points {
        min_x = min_x.min(p.x()); max_x = max_x.max(p.x());
        min_y = min_y.min(p.y()); max_y = max_y.max(p.y());
    }
    let center = Point::new((min_x + max_x)/2.0, (min_y + max_y)/2.0);
    let radius = ((max_x - min_x).powi(2) + (max_y - min_y).powi(2)).sqrt() / 2.0;

    let ctx = CostContext {
        outline: poly_points,
        obstacles: input.obstacles,
        bed_w: input.bed_width,
        bed_h: input.bed_height,
        center,
        radius,
    };

    if let Some(line) = input.initial_line {
        let (a_norm, o_norm, t_seed) = line_to_params(line[0], line[1], &ctx);
        let params = DVector::from_vec(vec![a_norm, o_norm, t_seed, 0.5, 0.5]);
        
        let (c1, log1, pts1_a, pts1_b) = evaluate_cost_detailed(&params, &ctx, false);
        let (c2, log2, pts2_a, pts2_b) = evaluate_cost_detailed(&params, &ctx, true);
        
        if c1 < c2 {
            return DebugEvalResult {
                log: format!("=== Normal State ===\\nCost: {:.4}\\n{}", c1, log1),
                cost: c1,
                points_a: pts1_a,
                points_b: pts1_b
            };
        } else {
            return DebugEvalResult {
                log: format!("=== Flipped State ===\\nCost: {:.4}\\n{}", c2, log2),
                cost: c2,
                points_a: pts2_a,
                points_b: pts2_b
            };
        }
    }
    
    DebugEvalResult { log: "Error: No line provided".to_string(), cost: -1.0, points_a: vec![], points_b: vec![] }
}