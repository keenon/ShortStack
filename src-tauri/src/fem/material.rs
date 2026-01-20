use nalgebra::{Matrix6, Matrix6x1, Vector3};

pub trait Material {
    fn c_matrix(&self) -> Matrix6<f64>;
}

#[derive(Debug, Clone, Copy)]
pub struct IsotropicMaterial {
    pub e: f64,  // Young's Modulus
    pub nu: f64, // Poisson's Ratio
}

impl Material for IsotropicMaterial {
    fn c_matrix(&self) -> Matrix6<f64> {
        let factor = self.e / ((1.0 + self.nu) * (1.0 - 2.0 * self.nu));
        let c1 = 1.0 - self.nu;
        let c2 = self.nu;
        let c3 = (1.0 - 2.0 * self.nu) / 2.0;

        let mut c = Matrix6::zeros();
        // Normal strains
        c[(0,0)] = c1; c[(0,1)] = c2; c[(0,2)] = c2;
        c[(1,0)] = c2; c[(1,1)] = c1; c[(1,2)] = c2;
        c[(2,0)] = c2; c[(2,1)] = c2; c[(2,2)] = c1;
        
        // Shear strains (Voigt: xx, yy, zz, xy, yz, zx)
        // Indices: 3=xy, 4=yz, 5=zx
        c[(3,3)] = c3;
        c[(4,4)] = c3;
        c[(5,5)] = c3;

        c * factor
    }
}

/// Orthotropic Material
/// Defined by 9 independent constants.
/// We store the "Major" Poisson's ratios (nu_xy corresponds to strain in y due to stress in x).
#[derive(Debug, Clone, Copy)]
pub struct OrthotropicMaterial {
    pub ex: f64, pub ey: f64, pub ez: f64,
    pub nu_xy: f64, pub nu_yz: f64, pub nu_xz: f64,
    pub g_xy: f64, pub g_yz: f64, pub g_zx: f64,
}

impl OrthotropicMaterial {
    /// Creates a material representing a 3D printed part (Transversely Isotropic).
    /// Assumes the "Weak" direction is Z (layer stacking direction).
    /// The XY plane is the "fill" plane (isotropic).
    /// 
    /// Parameters:
    /// - `e_fill`: Young's Modulus in X and Y.
    /// - `e_layer`: Young's Modulus in Z.
    /// - `nu_fill`: Poisson's ratio in plane (XY).
    /// - `nu_layer`: Poisson's ratio vertical (XZ and YZ).
    /// - `g_layer`: Shear modulus vertical (XZ and YZ).
    pub fn from_transverse_isotropy(
        e_fill: f64, 
        e_layer: f64, 
        nu_fill: f64, 
        nu_layer: f64, 
        g_layer: f64
    ) -> Self {
        // In-plane shear modulus is dependent for transverse isotropy
        let g_fill = e_fill / (2.0 * (1.0 + nu_fill));
        
        Self {
            ex: e_fill,
            ey: e_fill,
            ez: e_layer,
            nu_xy: nu_fill,
            nu_yz: nu_layer, // Y -> Z
            nu_xz: nu_layer, // X -> Z
            g_xy: g_fill,
            g_yz: g_layer,
            g_zx: g_layer,
        }
    }
}

impl Material for OrthotropicMaterial {
    fn c_matrix(&self) -> Matrix6<f64> {
        // It is much safer to build the Compliance Matrix (S) and invert it.
        // S * stress = strain
        // S_ii = 1/E_i
        // S_ij = -nu_ji / E_j = -nu_ij / E_i (Symmetry requirement)
        
        let mut s = Matrix6::zeros();
        
        // Diagonals (Normal)
        s[(0,0)] = 1.0 / self.ex;
        s[(1,1)] = 1.0 / self.ey;
        s[(2,2)] = 1.0 / self.ez;

        // Off-diagonals (Poisson coupling)
        // Row 0 (Strain X)
        s[(0,1)] = -self.nu_xy / self.ex; // Effect of Sy on Ex
        s[(0,2)] = -self.nu_xz / self.ex; // Effect of Sz on Ex

        // Row 1 (Strain Y)
        s[(1,0)] = -self.nu_xy / self.ex; // Symmetry: -nu_yx/Ey = -nu_xy/Ex
        s[(1,2)] = -self.nu_yz / self.ey;

        // Row 2 (Strain Z)
        s[(2,0)] = -self.nu_xz / self.ex; // Symmetry
        s[(2,1)] = -self.nu_yz / self.ey; // Symmetry

        // Shears (uncoupled in orthotropic axes)
        s[(3,3)] = 1.0 / self.g_xy;
        s[(4,4)] = 1.0 / self.g_yz;
        s[(5,5)] = 1.0 / self.g_zx;

        // Invert to get Stiffness C
        s.try_inverse().expect("Material Compliance Matrix is singular (check inputs)")
    }
}