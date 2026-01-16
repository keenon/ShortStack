use crate::geometry::*;
use cmaes::{CMAESOptions, DVector, PlotOptions};
use geo::{Point, LineString, Polygon, Euclidean, Distance};
use geo::algorithm::euclidean_distance::EuclideanDistance;
use geo::algorithm::contains::Contains;
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

#[derive(Clone)]
struct CostContext {
    outline: Vec<Point<f64>>,
    obstacles: Vec<Obstacle>,
    bed_w: f64,
    bed_h: f64,
    center: Point<f64>,
    radius: f64,
    // Inductive Bias: Target normalized Angle/Offset from PSO
    target_angle: Option<f64>,
    target_offset: Option<f64>,
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

    // Initialize Context
    let mut ctx = CostContext {
        outline: poly_points,
        obstacles: input.obstacles,
        bed_w: input.bed_width,
        bed_h: input.bed_height,
        center,
        radius,
        target_angle: None,
        target_offset: None,
    };

    let mut seeds = Vec::new();

    if let Some(line) = input.initial_line {
        let (a_norm, o_norm, t_seed) = line_to_params(line[0], line[1], &ctx);
        
        // 1. SET BIAS: Guide optimizer to stay near this line
        ctx.target_angle = Some(a_norm);
        ctx.target_offset = Some(o_norm);

        // 2. Seed 1: Trust input exactly
        seeds.push((vec![a_norm, o_norm, t_seed, 0.5, 0.5], 0.1));

        // 3. Grid Search along the line (varying T and Width)
        // Since we have a Bias setting, the optimizer will pull these back to the line
        // even if they drift, but starting at different T helps avoid local minima holes.
        let t_steps = vec![0.10, 0.25, 0.40, 0.50, 0.55, 0.70, 0.85];
        let w_steps = vec![0.3, 0.7]; 

        for t in t_steps {
            for w in &w_steps {
                seeds.push((vec![a_norm, o_norm, t, *w, 0.5], 0.1));
            }
        }
    } else {
        // Fallback global search
        seeds.push((vec![0.5, 0.5, 0.5, 0.5, 0.5], 0.2));
        for i in 0..4 {
            seeds.push((vec![i as f64/4.0, 0.5, 0.5, 0.5, 0.5], 0.2));
        }
    }

    let mut best_overall_cost = f64::MAX;
    let mut best_overall_cut: Option<GeneratedCut> = None;

    for flip_state in [false, true] {
        for (seed_vec, run_sigma) in &seeds {
            
            // --- FAST CHECK & LOGGING ---
            let seed_dvec = DVector::from_vec(seed_vec.clone());
            // Call detailed to get points
            let (seed_cost, _log, pts_a, pts_b) = evaluate_cost_detailed(&seed_dvec, &ctx, flip_state);
            
            println!("[Optimizer] Checking Seed (Flip={}): T={:.2} W={:.2} Cost={:.4}", flip_state, seed_vec[2], seed_vec[3], seed_cost);

            if seed_cost < 1.0 {
                println!("[Optimizer] EARLY EXIT on Seed");
                best_overall_cost = seed_cost;
                let (_, p1, p2, dt) = decode_params(&seed_dvec, &ctx, flip_state);
                
                let cut = GeneratedCut {
                    id: uuid::Uuid::new_v4().to_string(),
                    start: [p1.x(), p1.y()],
                    end: [p2.x(), p2.y()],
                    dovetail_width: dt.w,
                    dovetail_height: dt.h,
                    dovetail_t: dt.t,
                    flipped: flip_state,
                };
                println!("debug points A: {:?}", pts_a);
                println!("debug points B: {:?}", pts_b);
                return OptimizationResult {
                    success: seed_cost < 1.0,
                    cost: seed_cost,
                    shapes: vec![cut],
                    debug_points_a: pts_a,
                    debug_points_b: pts_b,
                };
            }
            // ----------------------------

            let ctx_clone = ctx.clone();
            
            // CMA-ES
            let mut cmaes_state = CMAESOptions::new(seed_vec.clone(), *run_sigma)
                .population_size(40)
                .max_generations(250)
                .enable_printing(2000) // Silent mostly
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
            // Stopping Condition: If nearly zero, we found a valid, non-colliding, compliant fit.
            if best_overall_cost < 1.0 { break; }
        }
        if best_overall_cost < 1.0 { break; }
    }

    match best_overall_cut {
        Some(cut) => OptimizationResult {
            success: best_overall_cost < 1.0,
            cost: best_overall_cost,
            shapes: vec![cut],
            debug_points_a: vec![], // Loop return handles mostly
            debug_points_b: vec![],
        },
        None => OptimizationResult { 
            success: false, cost: f64::MAX, shapes: vec![],
            debug_points_a: vec![], debug_points_b: vec![]
        }
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
    let mut cost_hard = 0.0; // Fit, Collision, Params
    let mut cost_soft = 0.0; // Bias, Centering
    
    // Detailed Accumulators for Logging
    let mut c_param = 0.0;
    let mut c_bias = 0.0;
    let mut c_obs_hit = 0.0;
    let mut c_obs_prox = 0.0;
    let mut c_fit = 0.0;

    // 1. Parameter Constraints (Hard)
    for (i, val) in x.iter().enumerate() {
        if *val < 0.0 { c_param += val.powi(2) * 1000.0; }
        if *val > 1.0 { c_param += (*val - 1.0).powi(2) * 1000.0; }
    }
    cost_hard += c_param;

    // 2. Inductive Bias (Soft with Deadzone)
    // We want to penalize deviating from PSO line, but allow a "valley" of 0 cost
    // so the optimizer feels successful if it stays close.
    let deadzone = 0.02;
    if let (Some(t_ang), Some(t_off)) = (ctx.target_angle, ctx.target_offset) {
        // Angle Deadzone
        let mut d_ang = (x[0] - t_ang).abs();
        if d_ang > 0.5 { d_ang = 1.0 - d_ang; } // Wrap
        if d_ang > deadzone { 
            c_bias += (d_ang - deadzone).powi(2) * 100000.0; 
        }

        // Offset Deadzone
        let d_off = (x[1] - t_off).abs();
        if d_off > deadzone {
            c_bias += (d_off - deadzone).powi(2) * 100000.0;
        }
    }
    cost_soft += c_bias;

    let (angle, p1, p2, dt) = decode_params(x, ctx, flipped);
    let ux = angle.cos();
    let uy = angle.sin();
    let (vx, vy) = if flipped { (uy, -ux) } else { (-uy, ux) };

    // Geometry Generation
    let center = Point::new(p1.x() + (p2.x() - p1.x()) * dt.t, p1.y() + (p2.y() - p1.y()) * dt.t);
    let base_half = dt.w / 2.0;
    let head_half = (dt.w * 1.5) / 2.0; 
    let base_l = Point::new(center.x() - ux * base_half, center.y() - uy * base_half);
    let base_r = Point::new(center.x() + ux * base_half, center.y() + uy * base_half);
    let head_l = Point::new(center.x() - ux * head_half + vx * dt.h, center.y() - uy * head_half + vy * dt.h);
    let head_r = Point::new(center.x() + ux * head_half + vx * dt.h, center.y() + uy * head_half + vy * dt.h);
    let cut_path = vec![(p1, base_l), (base_l, head_l), (head_l, head_r), (head_r, base_r), (base_r, p2)];

    // 3. Obstacle Check (SDF)
    let SENSOR_RANGE = 4.0; // mm
    let mut min_sdf = f64::MAX;

    for obs in &ctx.obstacles {
        match obs {
            Obstacle::Circle { x, y, r } => {
                let obs_p = Point::new(*x, *y);
                let mut min_dist_segment = f64::MAX;
                // Rule 1: NO part of the line (Straight or Dovetail) can touch circles
                for (s, e) in &cut_path {
                    min_dist_segment = min_dist_segment.min(dist_point_segment(obs_p, *s, *e));
                }
                
                let sdf = min_dist_segment - r;
                min_sdf = min_sdf.min(sdf);

                if sdf < 0.0 {
                    c_obs_hit += 10000.0 + sdf.powi(2) * 500000.0;
                } else if sdf < OBS_MARGIN {
                    c_obs_hit += (OBS_MARGIN - sdf).powi(2) * 5000.0;
                } else if sdf < SENSOR_RANGE {
                    let weight = (1.0 - sdf / SENSOR_RANGE).powi(2);
                    c_obs_prox += weight * 0.1; 
                }
            },
            Obstacle::Poly { points } => {
                // Construct Polygon
                let coords: Vec<Point<f64>> = points.iter().map(|p| Point::new(p[0], p[1])).collect();
                let poly = Polygon::new(LineString::from(coords), vec![]);

                // Rule 2: Only DOVETAIL segments (Indices 1, 2, 3) cannot touch Polygons.
                // Straight segments (0 and 4) are allowed to bridge across holes.
                for i in 1..=3 {
                    let (s, e) = cut_path[i];
                    let seg = geo::Line::new(s, e);
                    
                    // distance is 0 if intersecting or inside
                    let dist = seg.euclidean_distance(&poly);
                    
                    if dist < 0.001 {
                        // Hard Collision
                        c_obs_hit += 5000.0; 
                    } else if dist < OBS_MARGIN {
                        // Soft Buffer
                        c_obs_prox += (OBS_MARGIN - dist).powi(2) * 50.0;
                    }
                }
            }
        }
    }
    cost_hard += c_obs_hit;
    cost_soft += c_obs_prox;

    if cost_hard > 500.0 { 
        // Optimization: Don't compute fit if we are already crashing hard
        let msg = format!("High Cost Exit (Collision): {:.2}", cost_hard);
        return (cost_hard + cost_soft, msg, vec![], vec![]);
    }

    // 4. Fit Check
    let c_val = p1.x() * vx + p1.y() * vy;
    let mut pts_a = Vec::new(); 
    let mut pts_b = Vec::new(); 
    let protrusion = vec![base_l, head_l, head_r, base_r];
    pts_a.extend_from_slice(&protrusion);

    for p in &ctx.outline {
        let val = p.x() * vx + p.y() * vy;
        // Padding of 0.5 prevents numerical jitter at the cut line from dropping points
        if val >= c_val - 0.5 { pts_a.push(*p); }
        if val <= c_val + 0.5 { pts_b.push(*p); }
    }

    // Explicitly add intersection points to close the shapes cleanly
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
    
    if !intersections_found {
        // Fallback: If we missed the outline (e.g. line outside), preserve endpoints so we see 'something'
        pts_a.push(p1); pts_a.push(p2);
        pts_b.push(p1); pts_b.push(p2);
    }

    // --- MEASURE HULLS FOR LOGGING ---
    // Helper to get dimensions of a set of points (Approximate via AABB for log speed)
    let get_dims = |pts: &Vec<Point<f64>>| -> (f64, f64) {
        if pts.is_empty() { return (0.0, 0.0); }
        let (mut min_x, mut max_x) = (f64::MAX, f64::MIN);
        let (mut min_y, mut max_y) = (f64::MAX, f64::MIN);
        for p in pts {
            min_x = min_x.min(p.x()); max_x = max_x.max(p.x());
            min_y = min_y.min(p.y()); max_y = max_y.max(p.y());
        }
        (max_x - min_x, max_y - min_y)
    };

    let (w_a, h_a) = get_dims(&pts_a);
    let (w_b, h_b) = get_dims(&pts_b);

    let pen_a = check_fit(&pts_a, ctx.bed_w, ctx.bed_h);
    let pen_b = check_fit(&pts_b, ctx.bed_w, ctx.bed_h);
    c_fit = (pen_a + pen_b) * 100.0;
    
    cost_hard += c_fit;

    // Final Cost
    let total = cost_hard + cost_soft;

    // Elaborate Logging
    // We break down exactly why Fit failed (or didn't) by showing sizes vs bed
    let log_msg = format!(
        "Total: {:.4} (Hard: {:.2} Soft: {:.2})\\n  [PARAMS] Penalty: {:.2}\\n  [COLLISION] Cost: {:.2} (Min Dist: {:.2})\\n  [FIT] Cost: {:.2}\\n    Bed: {:.1}x{:.1}\\n    Part A: {} pts, Size {:.1}x{:.1} (Penalty {:.2})\\n    Part B: {} pts, Size {:.1}x{:.1} (Penalty {:.2})\\n  [BIAS] Cost: {:.2}",
        total, cost_hard, cost_soft, 
        c_param, 
        c_obs_hit, min_sdf, 
        c_fit, ctx.bed_w, ctx.bed_h,
        pts_a.len(), w_a, h_a, pen_a * 100.0,
        pts_b.len(), w_b, h_b, pen_b * 100.0,
        c_bias
    );

    let raw_a = pts_a.iter().map(|p| [p.x(), p.y()]).collect();
    let raw_b = pts_b.iter().map(|p| [p.x(), p.y()]).collect();

    (total, log_msg, raw_a, raw_b)
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
        target_angle: None,
        target_offset: None,
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