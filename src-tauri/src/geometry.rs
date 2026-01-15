use serde::{Deserialize, Serialize};
use geo::{
    algorithm::{convex_hull::ConvexHull},
    Point, Polygon, LineString, Line, Euclidean, Distance
};

// --- Data Structures ---

#[derive(Debug, Deserialize, Clone)]
pub struct GeometryInput {
    pub outline: Vec<[f64; 2]>,
    pub obstacles: Vec<Obstacle>,
    pub bed_width: f64,
    pub bed_height: f64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Obstacle {
    pub x: f64,
    pub y: f64,
    pub r: f64,
}

#[derive(Debug, Serialize)]
pub struct OptimizationResult {
    pub success: bool,
    pub cost: f64,
    pub shapes: Vec<GeneratedCut>,
}

#[derive(Debug, Serialize)]
pub struct GeneratedCut {
    pub id: String,
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub dovetail_width: f64,
    pub dovetail_height: f64,
    // t value 0.0-1.0 along the line
    pub dovetail_t: f64, 
}

// --- Geometric Helpers ---

/// Checks if a set of points fits in the bed (Standard or Rotated)
/// Returns a penalty score (0.0 = fits, >0.0 = excess area/length)
pub fn check_fit(points: &Vec<Point<f64>>, bed_w: f64, bed_h: f64) -> f64 {
    // 1. Compute Convex Hull (Geo crate makes this easy)
    // We need a LineString or Polygon for convex_hull
    let poly = LineString::from_iter(points.clone()).convex_hull();
    let hull_points: Vec<Point<f64>> = poly.exterior().points().collect();

    if hull_points.len() < 3 {
        return 0.0;
    }

    let mut min_excess = f64::MAX;

    // 2. Rotating Calipers (Simplified for Rectangle Fitting)
    let n = hull_points.len();
    for i in 0..n {
        let p1 = hull_points[i];
        let p2 = hull_points[(i + 1) % n];

        let dx = p2.x() - p1.x();
        let dy = p2.y() - p1.y();
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-6 { continue; }

        let ux = dx / len;
        let uy = dy / len;
        let vx = -uy;
        let vy = ux;

        // Project all points onto this axis system
        let (mut min_u, mut max_u) = (f64::MAX, f64::MIN);
        let (mut min_v, mut max_v) = (f64::MAX, f64::MIN);

        for p in &hull_points {
            let u = p.x() * ux + p.y() * uy;
            let v = p.x() * vx + p.y() * vy;
            min_u = min_u.min(u);
            max_u = max_u.max(u);
            min_v = min_v.min(v);
            max_v = max_v.max(v);
        }

        let w = max_u - min_u;
        let h = max_v - min_v;

        // Check Orientation 1
        let exc_1 = (w - bed_w).max(0.0) + (h - bed_h).max(0.0);
        // Check Orientation 2 (Rotated 90 deg)
        let exc_2 = (w - bed_h).max(0.0) + (h - bed_w).max(0.0);

        let current_excess = exc_1.min(exc_2);
        if current_excess < min_excess {
            min_excess = current_excess;
        }

        // Optimization: If it fits perfectly, return immediately
        if min_excess < 1e-4 {
            return 0.0;
        }
    }

    // Return squared penalty to encourage optimizer to fix big overflows fast
    min_excess * min_excess
}

/// Helper to get distance from a point to a line segment
pub fn dist_point_segment(p: Point<f64>, s_start: Point<f64>, s_end: Point<f64>) -> f64 {
    let line = Line::new(s_start, s_end);
    // p.euclidean_distance(&line)
    Euclidean::distance(&p, &line)
}

/// Helper to check if point is inside a polygon (Ray Casting)
pub fn is_point_in_poly(p: Point<f64>, poly: &Vec<Point<f64>>) -> bool {
    use geo::algorithm::contains::Contains;
    let polygon = Polygon::new(LineString::from_iter(poly.clone()), vec![]);
    polygon.contains(&p)
}