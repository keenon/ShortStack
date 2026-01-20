use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct IntegrationPoint {
    pub xi: [f64; 4], // Barycentric coordinates (L1, L2, L3, L4)
    pub weight: f64,
}

pub struct TetQuadrature;

impl TetQuadrature {
    /// Returns integration points for a requested order.
    /// Coordinates are Barycentric: L1, L2, L3, L4
    /// Weights are scaled to the Reference Volume (1/6).
    pub fn get_rule(points: u8) -> Vec<IntegrationPoint> {
        match points {
            1 => vec![IntegrationPoint {
                xi: [0.25, 0.25, 0.25, 0.25],
                weight: 1.0 / 6.0, 
            }],
            4 => {
                // Order 2 (Integrates Quadratics exactly)
                // Alpha = (5 - \sqrt{5}) / 20  approx 0.13819660
                // Beta  = (5 + 3\sqrt{5}) / 20 approx 0.58541020
                // Weights = 1/4 * Vol = 1/24
                let a = 0.5854101966249685; 
                let b = 0.1381966011250105;
                let w = 1.0 / 24.0; 
                vec![
                    IntegrationPoint { xi: [a, b, b, b], weight: w },
                    IntegrationPoint { xi: [b, a, b, b], weight: w },
                    IntegrationPoint { xi: [b, b, a, b], weight: w },
                    IntegrationPoint { xi: [b, b, b, a], weight: w },
                ]
            }
            5 => {
                // Order 3 (Integrates Cubics exactly)
                // Point 1: Centroid
                // Points 2-5: (1/2, 1/6, 1/6, 1/6) permutations
                
                // Weight 1: -4/5 * Volume = -4/5 * 1/6 = -2/15
                let w1 = -2.0 / 15.0; 
                // Weight 2: 9/20 * Volume = 9/20 * 1/6 = 3/40
                let w2 = 3.0 / 40.0;

                let p1 = 0.25;
                let p2_a = 0.5;
                let p2_b = 1.0 / 6.0;
                
                vec![
                    IntegrationPoint { xi: [p1, p1, p1, p1], weight: w1 }, 
                    IntegrationPoint { xi: [p2_a, p2_b, p2_b, p2_b], weight: w2 },
                    IntegrationPoint { xi: [p2_b, p2_a, p2_b, p2_b], weight: w2 },
                    IntegrationPoint { xi: [p2_b, p2_b, p2_a, p2_b], weight: w2 },
                    IntegrationPoint { xi: [p2_b, p2_b, p2_b, p2_a], weight: w2 },
                ]
            }
            _ => panic!("Unsupported integration rule"),
        }
    }
}