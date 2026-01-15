use crate::geometry::*;
use cmaes::{CMAESOptions, DVector, PlotOptions};
use geo::{Point, LineString, Polygon, Euclidean, Distance};
use std::f64::consts::PI;

const OBS_MARGIN: f64 = 1.5;
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

#[derive(Clone)] // Added Clone
struct CostContext {
    outline: Vec<Point<f64>>,
    obstacles: Vec<Obstacle>,
    bed_w: f64,
    bed_h: f64,
    center: Point<f64>,
    radius: f64,
}

fn line_to_params(start: [f64; 2], end: [f64; 2], ctx: &CostContext) -> (f64, f64) {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    
    // 1. Calculate Angle (0 to PI)
    let mut angle = dy.atan2(dx); // -PI to PI
    if angle < 0.0 { angle += PI; }
    if angle >= PI { angle -= PI; }
    let angle_norm = angle / PI;

    // 2. Calculate Offset
    // We need the normal vector to the line
    let len = (dx*dx + dy*dy).sqrt();
    let ux = dx / len;
    let uy = dy / len;
    let vx = -uy; // Normal vector X
    let vy = ux;  // Normal vector Y

    // Projection of the line onto its own normal
    let line_proj = start[0] * vx + start[1] * vy;
    // Projection of the board center onto that same normal
    let center_proj = ctx.center.x() * vx + ctx.center.y() * vy;
    
    // The difference is how far the line is from the center
    let offset_dist = line_proj - center_proj;
    
    // Normalize to 0.0 - 1.0 (relative to ctx.radius)
    // Formula from decode_params: offset_norm = (offset / radius) * 0.5 + 0.5
    let offset_norm = (offset_dist / ctx.radius) * 0.5 + 0.5;

    (angle_norm.clamp(0.0, 1.0), offset_norm.clamp(0.0, 1.0))
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

    // Default starting point (the middle of everything)
    let mut initial_mean = vec![0.5, 0.5, 0.5, 0.5, 0.5];
    let mut sigma = 0.2;

    // If we have a seed, overwrite the Angle and Offset parameters
    if let Some(line) = input.initial_line {
        let (a_norm, o_norm) = line_to_params(line[0], line[1], &ctx);
        initial_mean[0] = a_norm;
        initial_mean[1] = o_norm;
        
        // We reduce sigma because the line is "known", 
        // but we keep it high enough to let the dovetail (T, W, H) explore
        sigma = 0.1; 
    }

    let mut best_overall_cost = f64::MAX;
    let mut best_overall_cut: Option<GeneratedCut> = None;

    for flip_state in [false, true] {
        let ctx_clone = ctx.clone();
        
        let mut cmaes_state = CMAESOptions::new(initial_mean.clone(), sigma)
            .population_size(20)
            .max_generations(100)
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
        
        // Optimization: If we found a nearly perfect fit (cost ~0), stop early
        if best_overall_cost < 0.1 { break; }
    }

    match best_overall_cut {
        Some(cut) => OptimizationResult {
            success: best_overall_cost < 10.0,
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
    let (vx, vy) = if flipped {
        (uy, -ux)
    } else {
        (-uy, ux)
    };

    let anchor = Point::new(
        ctx.center.x() + vx * (offset_norm * ctx.radius),
        ctx.center.y() + vy * (offset_norm * ctx.radius)
    );
    
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

fn evaluate_cost(x: &DVector<f64>, ctx: &CostContext, flipped: bool) -> f64 {
    let mut cost = 0.0;
    for val in x.iter() {
        if *val < 0.0 { cost += val.powi(2) * 1000.0; }
        if *val > 1.0 { cost += (*val - 1.0).powi(2) * 1000.0; }
    }

    let (angle, p1, p2, dt) = decode_params(x, ctx, flipped);
    let ux = angle.cos();
    let uy = angle.sin();
    
    // Matches TS logic
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

    for obs in &ctx.obstacles {
        let obs_p = Point::new(obs.x, obs.y);
        let mut min_dist = f64::MAX;
        for (s, e) in &cut_path {
            min_dist = min_dist.min(dist_point_segment(obs_p, *s, *e));
        }
        let safe_dist = obs.r + OBS_MARGIN;
        if min_dist < safe_dist {
            cost += (safe_dist - min_dist).powi(2) * 5000.0;
        }
    }

    if cost > 100.0 { return cost; }

    // Fit Check: The "Male" protrusion is [base_l, head_l, head_r, base_r]
    // We need to know which side is which.
    // The "Normal" (vx, vy) points TOWARDS the male protrusion.
    let c_val = p1.x() * vx + p1.y() * vy;

    let mut pts_a = Vec::new(); // Side the protrusion is on
    let mut pts_b = Vec::new(); // Side the void is on

    let protrusion = vec![base_l, head_l, head_r, base_r];
    pts_a.extend_from_slice(&protrusion);

    for p in &ctx.outline {
        let val = p.x() * vx + p.y() * vy;
        // Points on the side of the normal go to A, others to B
        if val >= c_val - 0.5 { pts_a.push(*p); }
        if val <= c_val + 0.5 { pts_b.push(*p); }
    }

    pts_a.push(p1); pts_a.push(p2);
    pts_b.push(p1); pts_b.push(p2);

    cost += (check_fit(&pts_a, ctx.bed_w, ctx.bed_h) + check_fit(&pts_b, ctx.bed_w, ctx.bed_h)) * 10.0;
    cost
}