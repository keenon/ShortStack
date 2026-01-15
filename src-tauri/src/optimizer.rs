use crate::geometry::*;
use cmaes::{CMAESOptions, DVector, PlotOptions};
use geo::{Point, LineString, Polygon};
use std::f64::consts::PI;

const OBS_MARGIN: f64 = 1.5;
const MIN_W: f64 = 5.0;
const MAX_W: f64 = 25.0;
const MIN_H: f64 = 4.0;
const MAX_H: f64 = 12.0;

/// The structure we pass to the objective function
struct CostContext {
    outline: Vec<Point<f64>>,
    obstacles: Vec<Obstacle>,
    bed_w: f64,
    bed_h: f64,
    // Pre-calculated bounds of the board
    center: Point<f64>,
    radius: f64,
}

pub fn run_optimization(input: GeometryInput) -> OptimizationResult {
    // 1. Convert Input to Geo Types & Precompute center
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

    // 2. Setup CMA-ES
    // Dimensions: 5 parameters
    // 0: Angle (0 - PI)
    // 1: Offset (-1.0 to 1.0 relative to radius)
    // 2: Dovetail T (0.1 - 0.9)
    // 3: Dovetail W (Normalized 0-1)
    // 4: Dovetail H (Normalized 0-1)
    let dim = 5;
    let mut cmaes_state = CMAESOptions::new(vec![0.5; dim], 0.3) // Start mid-range, sigma 0.3
        .enable_logging(false)
        .population_size(20)
        .max_generations(100)
        .build(move |x: &DVector<f64>| evaluate_cost(x, &ctx))
        .unwrap();

    let result = cmaes_state.run();
    
    // 3. Decode Best Result
    let best_params = result.best_parameters;
    let best_cost = result.best_fitness;

    let (angle, cut_start, cut_end, dt_shape) = decode_params(&best_params, &ctx);

    let cut = GeneratedCut {
        id: uuid::Uuid::new_v4().to_string(),
        start: [cut_start.x(), cut_start.y()],
        end: [cut_end.x(), cut_end.y()],
        dovetail_width: dt_shape.w,
        dovetail_height: dt_shape.h,
        dovetail_t: dt_shape.t,
    };

    OptimizationResult {
        success: best_cost < 5.0, // Arbitrary threshold for "good fit"
        cost: best_cost,
        shapes: vec![cut],
    }
}

struct DovetailShape { t: f64, w: f64, h: f64 }

fn decode_params(x: &DVector<f64>, ctx: &CostContext) -> (f64, Point<f64>, Point<f64>, DovetailShape) {
    // Clamp inputs to 0.0-1.0 for safety (CMAES doesn't strictly bound)
    let safe_x: Vec<f64> = x.iter().map(|v| v.clamp(0.0, 1.0)).collect();

    let angle = safe_x[0] * PI; // 0 to 180 deg
    let offset_norm = (safe_x[1] - 0.5) * 2.0; // -1 to 1
    
    let ux = angle.cos();
    let uy = angle.sin();
    let vx = -uy;
    let vy = ux;

    // Calculate Cut Line Plane
    // We project the center, then move 'offset' amount along the normal
    let center_proj = ctx.center.x() * vx + ctx.center.y() * vy;
    let cut_plane = center_proj + (offset_norm * ctx.radius);

    // Find intersection with board outline to get actual line segment
    // This is a simplified "Infinite Line Clip"
    // In reality, you'd loop through outline segments and find intersections.
    // For optimization speed, we often use a "Large Segment" and rely on hull calculation to clean it up,
    // or do a quick Sutherland-Hodgman pass.
    
    // Let's create a "virtual" long line for calculation
    let anchor = Point::new(
        ctx.center.x() + vx * (offset_norm * ctx.radius),
        ctx.center.y() + vy * (offset_norm * ctx.radius)
    );
    
    // We need to find where this line enters and exits the polygon
    // Iterate edges
    let mut t_enter = -f64::MAX;
    let mut t_exit = f64::MAX;
    
    // Determine span along the cut line
    for p in &ctx.outline {
        // Project p onto line vector (ux, uy) relative to anchor
        let t = (p.x() - anchor.x()) * ux + (p.y() - anchor.y()) * uy;
        // Project p onto normal vector to see if it's "close" to plane is tricky for non-convex.
        // Better approach for strict cut line:
        // Use a very large line and clip it.
    }
    
    // FAST APPROXIMATION for Optimizer:
    // Just find the min/max projection of the outline onto the cut vector
    // This assumes the cut goes all the way through.
    let mut min_t = f64::MAX;
    let mut max_t = f64::MIN;
    
    for p in &ctx.outline {
        let t = (p.x() - anchor.x()) * ux + (p.y() - anchor.y()) * uy;
        // Check if this point is somewhat near our cut plane? 
        // Actually, strictly speaking, the start/end of the cut are defined by the intersection 
        // with the perimeter. 
        // For the sake of the optimizer state, let's assume the cut is valid if it sits within the bounding box.
        min_t = min_t.min(t);
        max_t = max_t.max(t);
    }
    
    let len = max_t - min_t;
    let p1 = Point::new(anchor.x() + ux * min_t, anchor.y() + uy * min_t);
    let p2 = Point::new(anchor.x() + ux * max_t, anchor.y() + uy * max_t);

    let t_val = 0.1 + safe_x[2] * 0.8; // Keep dovetail away from very edges (10% - 90%)
    let w_val = MIN_W + safe_x[3] * (MAX_W - MIN_W);
    let h_val = MIN_H + safe_x[4] * (MAX_H - MIN_H);

    (angle, p1, p2, DovetailShape { t: t_val, w: w_val, h: h_val })
}

fn evaluate_cost(x: &DVector<f64>, ctx: &CostContext) -> f64 {
    let mut cost = 0.0;
    
    // 1. Boundary Constraints (Soft) - Penalize if parameters go outside 0-1
    for val in x.iter() {
        if *val < 0.0 { cost += val.powi(2) * 1000.0; }
        if *val > 1.0 { cost += (*val - 1.0).powi(2) * 1000.0; }
    }

    let (angle, p1, p2, dt) = decode_params(x, ctx);
    let ux = angle.cos();
    let uy = angle.sin();
    let vx = -uy;
    let vy = ux;

    // 2. Generate Points (Pre-calculation)
    let cut_len = p1.euclidean_distance(&p2);
    if cut_len < dt.w * 1.5 { return 10000.0; } 

    // Calculate the 4 corners of the dovetail
    let center = Point::new(
        p1.x() + (p2.x() - p1.x()) * dt.t,
        p1.y() + (p2.y() - p1.y()) * dt.t
    );

    let base_half = dt.w / 2.0;
    // Standard 1:1.5 aspect ratio flare or derived from height/angle
    // If H is controlled, usually width increases. Let's assume simple trapezoid math:
    let head_half = (dt.w * 1.5) / 2.0; 
    
    // Base points (on the main cut line)
    let base_l = Point::new(center.x() - ux * base_half, center.y() - uy * base_half);
    let base_r = Point::new(center.x() + ux * base_half, center.y() + uy * base_half);
    
    // Head points (projected out)
    let head_l = Point::new(center.x() - ux * head_half + vx * dt.h, center.y() - uy * head_half + vy * dt.h);
    let head_r = Point::new(center.x() + ux * head_half + vx * dt.h, center.y() + uy * head_half + vy * dt.h);

    // Define the specific path the cutting tool takes
    // We do NOT check base_r -> base_l (the imaginary closing line)
    let cut_path = vec![
        (p1, base_l),      // 1. Approach
        (base_l, head_l),  // 2. Dovetail In
        (head_l, head_r),  // 3. Dovetail Head
        (head_r, base_r),  // 4. Dovetail Out
        (base_r, p2)       // 5. Exit
    ];

    // 3. Obstacle Avoidance (Distance to Path)
    for obs in &ctx.obstacles {
        let obs_p = Point::new(obs.x, obs.y);
        let safe_dist = obs.r + OBS_MARGIN;
        
        let mut min_dist_to_cut = f64::MAX;

        // Check distance to all 5 segments of the actual cut
        for (seg_start, seg_end) in &cut_path {
            let d = dist_point_segment(obs_p, *seg_start, *seg_end);
            if d < min_dist_to_cut {
                min_dist_to_cut = d;
            }
        }

        // Apply penalty only if we are physically too close to the cut line
        if min_dist_to_cut < safe_dist {
            // We use a quadratic penalty to create a smooth gradient for the optimizer
            let penetration = safe_dist - min_dist_to_cut;
            // High weight (5000.0) because cutting through a component is catastrophic
            cost += penetration * penetration * 5000.0;
        }
    }

    // Optimization: If obstacles are hit bad, skip expensive fit check
    if cost > 100.0 { return cost; }

    // 4. Fit Check (The Heavy Lifting)
    // We need to approximate the hulls of the two resulting pieces.
    // Piece A: "Left" of cut + Dovetail Protrusion
    // Piece B: "Right" of cut (Void is internal, so Hull is just the cut outline)

    // Calculate projection of cut line constant
    // The cut line passes through 'p1' with normal (vx, vy)
    // equation: x*vx + y*vy = C
    let c_val = p1.x() * vx + p1.y() * vy;

    // Collect points for Piece A (Left) and Piece B (Right)
    let mut pts_a = Vec::with_capacity(ctx.outline.len() + 4);
    let mut pts_b = Vec::with_capacity(ctx.outline.len());

    // Add Dovetail points to Male side (let's say A is Male)
    pts_a.extend_from_slice(&dovetail_poly);

    for p in &ctx.outline {
        let val = p.x() * vx + p.y() * vy;
        
        // Soft clipping: Include points if they are on the side or close to line
        // We include points "close" to the line in both to ensure convex hull integrity near the cut
        if val <= c_val + 1.0 { pts_a.push(*p); }
        if val >= c_val - 1.0 { pts_b.push(*p); }
    }

    // Add start/end of cut line to both to close the geometry visually for the Hull
    pts_a.push(p1); pts_a.push(p2);
    pts_b.push(p1); pts_b.push(p2);

    let fit_a = check_fit(&pts_a, ctx.bed_w, ctx.bed_h);
    let fit_b = check_fit(&pts_b, ctx.bed_w, ctx.bed_h);

    // Weight the fit heavily
    cost += (fit_a + fit_b) * 10.0;

    cost
}