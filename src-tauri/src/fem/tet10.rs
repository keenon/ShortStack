use nalgebra::{Matrix3, Matrix6x3, SMatrix, Vector3, Vector6};
use super::quadrature::IntegrationPoint;

/// Tet10: 10-node Quadratic Tetrahedron
/// Node ordering (VTK convention):
/// 0-3: Corners
/// 4-9: Mid-edge nodes (0-1, 1-2, 2-0, 0-3, 1-3, 2-3)
pub struct Tet10;

impl Tet10 {
    /// Calculate Shape Functions (N)
    /// xi, eta, zeta correspond to L1, L2, L3. L4 is dependent.
    pub fn shape_functions(l: &[f64; 4]) -> [f64; 10] {
        let (l1, l2, l3, l4) = (l[0], l[1], l[2], l[3]);
        [
            l1 * (2.0 * l1 - 1.0), // N0
            l2 * (2.0 * l2 - 1.0), // N1
            l3 * (2.0 * l3 - 1.0), // N2
            l4 * (2.0 * l4 - 1.0), // N3
            4.0 * l1 * l2,         // N4 (0-1)
            4.0 * l2 * l3,         // N5 (1-2)
            4.0 * l3 * l1,         // N6 (2-0)
            4.0 * l1 * l4,         // N7 (0-3)
            4.0 * l2 * l4,         // N8 (1-3)
            4.0 * l3 * l4,         // N9 (2-3)
        ]
    }

    /// Calculate Derivatives of Shape Functions with respect to Reference Cartesian (r, s, t)
    /// where r=L2, s=L3, t=L4.
    /// Returns 3x10 matrix: 
    /// Row 0: dN/dr (associated with X-axis)
    /// Row 1: dN/ds (associated with Y-axis)
    /// Row 2: dN/dt (associated with Z-axis)
    pub fn shape_function_derivatives(l: &[f64; 4]) -> SMatrix<f64, 3, 10> {
        let (l1, l2, l3, l4) = (l[0], l[1], l[2], l[3]);
        let mut dn = SMatrix::<f64, 3, 10>::zeros();

        // 1. Calculate partial derivatives w.r.t raw barycentric coords Li
        // We store these temporarily or compute on fly.
        // dNi_dL is the partial derivative of Ni with respect to L, holding others constant.
        
        // Helper closure for corner nodes: N = L(2L-1) -> dN/dL = 4L - 1
        let d_corner = |val: f64| 4.0 * val - 1.0;
        
        // Partials for Corners
        let p_n0_dl1 = d_corner(l1);
        let p_n1_dl2 = d_corner(l2);
        let p_n2_dl3 = d_corner(l3);
        let p_n3_dl4 = d_corner(l4);

        // Midsides (N = 4 Li Lj)
        // Partials are 4*Lj (w.r.t Li) and 4*Li (w.r.t Lj)

        // Apply Chain Rule: dN/dr = dN/dL2 * (dL2/dr) + dN/dL1 * (dL1/dr)
        // Since r=L2, dL2/dr=1. Since L1=1-r-s-t, dL1/dr=-1.
        // Formula: dN/dr = dN/dL2 - dN/dL1
        // Formula: dN/ds = dN/dL3 - dN/dL1
        // Formula: dN/dt = dN/dL4 - dN/dL1

        // -- Node 0 (Corner, depends on L1) --
        // dN0/dL1 = p_n0_dl1. dN0/dL{2,3,4} = 0.
        dn[(0, 0)] = -p_n0_dl1; // dN/dr
        dn[(1, 0)] = -p_n0_dl1; // dN/ds
        dn[(2, 0)] = -p_n0_dl1; // dN/dt

        // -- Node 1 (Corner, depends on L2) --
        dn[(0, 1)] = p_n1_dl2;
        dn[(1, 1)] = 0.0;
        dn[(2, 1)] = 0.0;

        // -- Node 2 (Corner, depends on L3) --
        dn[(0, 2)] = 0.0;
        dn[(1, 2)] = p_n2_dl3;
        dn[(2, 2)] = 0.0;

        // -- Node 3 (Corner, depends on L4) --
        dn[(0, 3)] = 0.0;
        dn[(1, 3)] = 0.0;
        dn[(2, 3)] = p_n3_dl4;

        // -- Node 4 (0-1: 4 L1 L2) --
        let d_n4_dl1 = 4.0 * l2;
        let d_n4_dl2 = 4.0 * l1;
        dn[(0, 4)] = d_n4_dl2 - d_n4_dl1;
        dn[(1, 4)] = 0.0      - d_n4_dl1;
        dn[(2, 4)] = 0.0      - d_n4_dl1;

        // -- Node 5 (1-2: 4 L2 L3) --
        let d_n5_dl2 = 4.0 * l3;
        let d_n5_dl3 = 4.0 * l2;
        dn[(0, 5)] = d_n5_dl2; // - 0
        dn[(1, 5)] = d_n5_dl3; // - 0
        dn[(2, 5)] = 0.0;

        // -- Node 6 (2-0: 4 L3 L1) --
        let d_n6_dl3 = 4.0 * l1;
        let d_n6_dl1 = 4.0 * l3;
        dn[(0, 6)] = 0.0      - d_n6_dl1;
        dn[(1, 6)] = d_n6_dl3 - d_n6_dl1;
        dn[(2, 6)] = 0.0      - d_n6_dl1;

        // -- Node 7 (0-3: 4 L1 L4) --
        let d_n7_dl1 = 4.0 * l4;
        let d_n7_dl4 = 4.0 * l1;
        dn[(0, 7)] = 0.0      - d_n7_dl1;
        dn[(1, 7)] = 0.0      - d_n7_dl1;
        dn[(2, 7)] = d_n7_dl4 - d_n7_dl1;

        // -- Node 8 (1-3: 4 L2 L4) --
        let d_n8_dl2 = 4.0 * l4;
        let d_n8_dl4 = 4.0 * l2;
        dn[(0, 8)] = d_n8_dl2;
        dn[(1, 8)] = 0.0;
        dn[(2, 8)] = d_n8_dl4;

        // -- Node 9 (2-3: 4 L3 L4) --
        let d_n9_dl3 = 4.0 * l4;
        let d_n9_dl4 = 4.0 * l3;
        dn[(0, 9)] = 0.0;
        dn[(1, 9)] = d_n9_dl3;
        dn[(2, 9)] = d_n9_dl4;

        dn
    }

    /// Calculate Jacobian Matrix (3x3) mapping Reference -> Global
    /// J = sum( dNi/dxi * xi )
    pub fn jacobian(node_coords: &[Vector3<f64>; 10], local_derivs: &SMatrix<f64, 3, 10>) -> Matrix3<f64> {
        let mut j = Matrix3::zeros();
        for i in 0..10 {
            let coords = node_coords[i];
            let d_n = local_derivs.column(i);
            // J = [dx/dL1 dy/dL1 dz/dL1; ...]
            j += d_n * coords.transpose();
        }
        j
    }

    /// Build Strain-Displacement Matrix B (6 x 30)
    /// Uses Voigt notation: xx, yy, zz, xy, yz, zx
    pub fn b_matrix(global_derivs: &SMatrix<f64, 3, 10>) -> SMatrix<f64, 6, 30> {
        let mut b = SMatrix::<f64, 6, 30>::zeros();

        for i in 0..10 {
            let d_nx = global_derivs[(0, i)];
            let d_ny = global_derivs[(1, i)];
            let d_nz = global_derivs[(2, i)];
            let col = i * 3;

            // Row 0: epsilon_xx -> dN/dx
            b[(0, col)]     = d_nx;
            // Row 1: epsilon_yy -> dN/dy
            b[(1, col + 1)] = d_ny;
            // Row 2: epsilon_zz -> dN/dz
            b[(2, col + 2)] = d_nz;
            
            // Row 3: gamma_xy -> dN/dy, dN/dx
            b[(3, col)]     = d_ny;
            b[(3, col + 1)] = d_nx;

            // Row 4: gamma_yz -> dN/dz, dN/dy
            b[(4, col + 1)] = d_nz;
            b[(4, col + 2)] = d_ny;

            // Row 5: gamma_zx -> dN/dz, dN/dx
            b[(5, col)]     = d_nz;
            b[(5, col + 2)] = d_nx;
        }
        b
    }
}