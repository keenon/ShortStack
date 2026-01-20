#[cfg(test)]
mod tests {
    use crate::fem::quadrature::TetQuadrature;
    use crate::fem::tet10::Tet10;
    use crate::fem::material::{IsotropicMaterial, OrthotropicMaterial, Material};
    use nalgebra::{Vector3, Matrix3};
    use approx::assert_relative_eq;

    #[test]
    fn test_integrate_one() {
        // Integrate f(x)=1. Should be 1/6.
        let rule = TetQuadrature::get_rule(5);
        let mut sum = 0.0;
        for q in rule {
            sum += 1.0 * q.weight;
        }
        // 1/6 = 0.166666...
        assert_relative_eq!(sum, 1.0 / 6.0, epsilon = 1e-9);
    }

    #[test]
    fn test_integrate_x() {
        // Integrate f(x) = x over reference tet.
        // Analytical: 1/24.
        let rule = TetQuadrature::get_rule(5);
        let mut sum = 0.0;
        for q in rule {
            let x = q.xi[0]; 
            sum += x * q.weight;
        }
        assert_relative_eq!(sum, 1.0 / 24.0, epsilon = 1e-9);
    }

    #[test]
    fn test_partition_of_unity() {
        // Check at a random point inside the tet
        let xi = [0.2, 0.3, 0.1, 0.4];
        let n = Tet10::shape_functions(&xi);
        let sum: f64 = n.iter().sum();
        assert_relative_eq!(sum, 1.0, epsilon = 1e-9);
    }

    #[test]
    fn test_derivative_consistency() {
        let l = [0.2, 0.3, 0.1, 0.4];
        let eps = 1e-6;
        let analytical = Tet10::shape_function_derivatives(&l);
        
        // Check dN/dr (Row 0)
        // r corresponds to L2. If we increase r by eps, L2 increases by eps, L1 decreases by eps.
        // L3, L4 stay constant.
        let l_pert_r = [l[0] - eps, l[1] + eps, l[2], l[3]];
        let n_orig = Tet10::shape_functions(&l);
        let n_pert = Tet10::shape_functions(&l_pert_r);

        for i in 0..10 {
            let fd = (n_pert[i] - n_orig[i]) / eps;
            assert_relative_eq!(fd, analytical[(0, i)], epsilon = 1e-5);
        }

        // Check dN/ds (Row 1) -> Perturb L3, reduce L1
        let l_pert_s = [l[0] - eps, l[1], l[2] + eps, l[3]];
        let n_pert_s = Tet10::shape_functions(&l_pert_s);
        for i in 0..10 {
            let fd = (n_pert_s[i] - n_orig[i]) / eps;
            assert_relative_eq!(fd, analytical[(1, i)], epsilon = 1e-5);
        }
    }

    #[test]
    fn test_jacobian_volume() {
        // Distorted Tet: Node 1 moved to (2,0,0). All others standard.
        // Analytical Volume = 1/6 * (Base Area * Height)
        // Base in YZ plane is 0.5. Height in X is 2.0. Vol = 1/3 * 0.5 * 2.0 = 1/3.
        
        let mut nodes = [Vector3::zeros(); 10];
        nodes[0] = Vector3::new(0.0, 0.0, 0.0);
        nodes[1] = Vector3::new(2.0, 0.0, 0.0); // Stretched
        nodes[2] = Vector3::new(0.0, 1.0, 0.0);
        nodes[3] = Vector3::new(0.0, 0.0, 1.0);
        
        // Midside nodes (Linear placement) ensures constant Jacobian
        nodes[4] = (nodes[0] + nodes[1]) * 0.5;
        nodes[5] = (nodes[1] + nodes[2]) * 0.5;
        nodes[6] = (nodes[2] + nodes[0]) * 0.5;
        nodes[7] = (nodes[0] + nodes[3]) * 0.5;
        nodes[8] = (nodes[1] + nodes[3]) * 0.5;
        nodes[9] = (nodes[2] + nodes[3]) * 0.5;

        let rule = TetQuadrature::get_rule(5);
        let mut numeric_vol = 0.0;

        for q in rule {
            let local_derivs = Tet10::shape_function_derivatives(&q.xi);
            let j = Tet10::jacobian(&nodes, &local_derivs);
            let det_j = j.determinant();
            numeric_vol += det_j * q.weight;
        }

        assert_relative_eq!(numeric_vol, 1.0 / 3.0, epsilon = 1e-9);
    }

    #[test]
    fn test_rigid_body_motion() {
        // Standard Reference Tet
        let mut nodes = [Vector3::zeros(); 10];
        nodes[0] = Vector3::new(0.0,0.0,0.0);
        nodes[1] = Vector3::new(1.0,0.0,0.0);
        nodes[2] = Vector3::new(0.0,1.0,0.0);
        nodes[3] = Vector3::new(0.0,0.0,1.0);
        nodes[4] = Vector3::new(0.5,0.0,0.0); nodes[5] = Vector3::new(0.5,0.5,0.0); nodes[6] = Vector3::new(0.0,0.5,0.0);
        nodes[7] = Vector3::new(0.0,0.0,0.5); nodes[8] = Vector3::new(0.5,0.0,0.5); nodes[9] = Vector3::new(0.0,0.5,0.5);

        // Check at one integration point
        let rule = TetQuadrature::get_rule(1); 
        let local_derivs = Tet10::shape_function_derivatives(&rule[0].xi);
        let j = Tet10::jacobian(&nodes, &local_derivs);
        let inv_j = j.try_inverse().expect("Jacobian singular");
        
        let global_derivs = inv_j * local_derivs;
        let b = Tet10::b_matrix(&global_derivs);

        // Displacement: u_x = 1.0 for all nodes
        let mut u = nalgebra::SVector::<f64, 30>::zeros();
        for i in 0..10 {
            u[i*3] = 1.0; 
        }

        let strain = b * u;
        // Strain should be zero
        assert_relative_eq!(strain.norm(), 0.0, epsilon = 1e-9);
    }

    // --- Material Tests ---

    #[test]
    fn test_isotropic_shear_modulus_consistency() {
        let e = 200e9;
        let nu = 0.3;
        let mat = IsotropicMaterial { e, nu };
        let c = mat.c_matrix();

        // Analytical Shear Modulus G
        let g_analytical = e / (2.0 * (1.0 + nu));
        
        // In the C matrix (Voigt), the shear terms (3,3), (4,4), (5,5) correspond to G
        // Note: Some formulations use G directly, others (like standard Voigt) might 
        // use G for engineering strain. 
        // nalgebra matrix multiplication C*epsilon = sigma.
        // sigma_xy = C_33 * gamma_xy.
        // Relation: tau = G * gamma. So C_33 should be exactly G.
        
        assert_relative_eq!(c[(3,3)], g_analytical, epsilon = 1.0);
        assert_relative_eq!(c[(4,4)], g_analytical, epsilon = 1.0);
        assert_relative_eq!(c[(5,5)], g_analytical, epsilon = 1.0);
    }

    #[test]
    fn test_orthotropic_symmetry() {
        // Random orthotropic properties
        let mat = OrthotropicMaterial {
            ex: 50e9, ey: 20e9, ez: 10e9,
            nu_xy: 0.25, nu_yz: 0.3, nu_xz: 0.1,
            g_xy: 5e9, g_yz: 4e9, g_zx: 3e9,
        };

        let c = mat.c_matrix();

        // Maxwell's Reciprocity Theorem requires the Stiffness matrix to be symmetric
        // C_ij = C_ji
        for i in 0..6 {
            for j in 0..6 {
                assert_relative_eq!(c[(i,j)], c[(j,i)], epsilon = 1e-3);
            }
        }
    }

    #[test]
    fn test_orthotropic_reduces_to_isotropic() {
        // Create an "Orthotropic" material that is actually isotropic
        let e = 100.0;
        let nu = 0.25;
        let g = e / (2.0 * (1.0 + nu));

        let iso = IsotropicMaterial { e, nu };
        let ortho = OrthotropicMaterial {
            ex: e, ey: e, ez: e,
            nu_xy: nu, nu_yz: nu, nu_xz: nu,
            g_xy: g, g_yz: g, g_zx: g
        };

        let c_iso = iso.c_matrix();
        let c_ortho = ortho.c_matrix();

        // The matrices should be identical
        for i in 0..6 {
            for j in 0..6 {
                assert_relative_eq!(c_iso[(i,j)], c_ortho[(i,j)], epsilon = 1e-4);
            }
        }
    }

    #[test]
    fn test_transverse_isotropy_weak_z() {
        // 3D Printing setup: Strong X/Y, Weak Z.
        // E_fill = 1000, E_layer = 100.
        let mat = OrthotropicMaterial::from_transverse_isotropy(
            1000.0, // E_fill
            100.0,  // E_layer (Weak)
            0.3,    // nu_fill
            0.1,    // nu_layer
            50.0    // G_layer (Weak Shear)
        );

        let c = mat.c_matrix();

        // 1. Verify Plane Symmetry: Behavior in X (index 0) should be similar to Y (index 1)
        // C_00 (Ex stiffness) approx C_11 (Ey stiffness)
        assert_relative_eq!(c[(0,0)], c[(1,1)], epsilon = 1e-4);
        
        // 2. Verify Weakness in Z (index 2)
        // C_22 (Ez stiffness) should be significantly lower than C_00
        assert!(c[(2,2)] < c[(0,0)]);

        // 3. Verify Shear coupling
        // C_44 (G_yz) should equal C_55 (G_zx) because Z is the axis of symmetry
        assert_relative_eq!(c[(4,4)], c[(5,5)], epsilon = 1e-4);
    }

    #[test]
    fn test_jacobian_quality_check() {
        use crate::fem::mesh::TetMesh;

        let mut vertices = vec![
            [0.0, 0.0, 0.0], // 0
            [1.0, 0.0, 0.0], // 1
            [0.0, 1.0, 0.0], // 2
            [0.0, 0.0, 1.0], // 3
            // Mids (Linear approx)
            [0.5, 0.0, 0.0], [0.5, 0.5, 0.0], [0.0, 0.5, 0.0],
            [0.0, 0.0, 0.5], [0.5, 0.0, 0.5], [0.0, 0.5, 0.5],
        ];

        // Element 0: Good Tet
        let indices_good = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

        // Element 1: Inverted Tet (Swap nodes 0 and 1)
        // This makes the basis (1-0, 2-0, 3-0) become (-1,0,0), resulting in neg volume
        let indices_bad = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9]; 

        let mesh = TetMesh::new(
            vertices.clone(), 
            vec![indices_good, indices_bad]
        );

        let bad_elems = mesh.check_jacobian_quality(1e-9);
        
        // Element 0 is good. Element 1 is bad.
        assert!(!bad_elems.contains(&0));
        assert!(bad_elems.contains(&1));
    }

    // #[test]
    // fn test_inverse_mapping() {
    //     // Create a standard tet
    //     let mut nodes = [Vector3::zeros(); 10];
    //     nodes[0] = Vector3::new(0.0, 0.0, 0.0);
    //     nodes[1] = Vector3::new(2.0, 0.0, 0.0); // Stretched X
    //     nodes[2] = Vector3::new(0.0, 1.0, 0.0);
    //     nodes[3] = Vector3::new(0.0, 0.0, 1.0);
    //     // Linear mids
    //     nodes[4] = Vector3::new(1.0, 0.0, 0.0); nodes[5] = Vector3::new(1.0, 0.5, 0.0); nodes[6] = Vector3::new(0.0, 0.5, 0.0);
    //     nodes[7] = Vector3::new(0.0, 0.0, 0.5); nodes[8] = Vector3::new(1.0, 0.0, 0.5); nodes[9] = Vector3::new(0.0, 0.5, 0.5);

    //     // Pick a target point inside: centroid
    //     // x = (0+2+0+0)/4 = 0.5
    //     // y = 0.25
    //     // z = 0.25
    //     let target = Vector3::new(0.5, 0.25, 0.25);
        
    //     let result = Tet10::world_to_reference(target, &nodes).expect("Inverse mapping failed");

    //     // The centroid of the reference tet is (0.25, 0.25, 0.25, 0.25)
    //     assert_relative_eq!(result[0], 0.25, epsilon = 1e-5);
    //     assert_relative_eq!(result[1], 0.25, epsilon = 1e-5);
    //     assert_relative_eq!(result[2], 0.25, epsilon = 1e-5);
    //     assert_relative_eq!(result[3], 0.25, epsilon = 1e-5);
    // }

    // #[test]
    // fn test_inverse_mapping_outside() {
    //     let mut nodes = [Vector3::zeros(); 10];
    //     nodes[0] = Vector3::new(0.0, 0.0, 0.0);
    //     nodes[1] = Vector3::new(1.0, 0.0, 0.0);
    //     nodes[2] = Vector3::new(0.0, 1.0, 0.0);
    //     nodes[3] = Vector3::new(0.0, 0.0, 1.0);
    //     // Fill mids...
    //     nodes[4] = Vector3::new(0.5,0.,0.); nodes[5] = Vector3::new(0.5,0.5,0.); nodes[6] = Vector3::new(0.,0.5,0.);
    //     nodes[7] = Vector3::new(0.,0.,0.5); nodes[8] = Vector3::new(0.5,0.,0.5); nodes[9] = Vector3::new(0.,0.5,0.5);

    //     // Point far outside (e.g. x=5)
    //     let target = Vector3::new(5.0, 0.0, 0.0);
    //     let result = Tet10::world_to_reference(target, &nodes);
    //     println!("Result for outside point: {:?}", result);
    //     // Should return None
    //     assert!(result.is_none());
    // }
}
