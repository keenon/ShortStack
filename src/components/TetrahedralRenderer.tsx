// src/components/TetrahedralRenderer.tsx
import { useMemo, useRef, useLayoutEffect } from "react";
import * as THREE from "three";

interface Props {
  mesh: { vertices: number[]; indices: number[][] }; // indices is array of [n1, n2, n3, n4]
  shrinkFactor: number;
  color: string;
  clipZ: number; // NEW: Max Z height to render
  minZ: number;  // NEW: Bottom of the model
}

export default function TetrahedralRenderer({ mesh, shrinkFactor, color, clipZ, minZ }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  // Create a canonical tetrahedron geometry (reference shape)
  // We will scale/transform this instance to match the specific tet shapes
  // Actually, for arbitrary tets, InstancedMesh is hard because shapes differ.
  // We should use a single BufferGeometry with "triangle soup" for performance.
  
  const geometry = useMemo(() => {
    const indices = mesh.indices;
    const vertices = mesh.vertices;
    
    // We generate independent triangles for flat shading and shrinking
    const posAttribute: number[] = [];
    const colorAttribute: number[] = [];
    const baseColor = new THREE.Color(color);

    // Filter tets based on centroid Z
    const filteredIndices = indices.filter(tet => {
        // Calculate centroid Z
        const z1 = vertices[tet[0]*3 + 2];
        const z2 = vertices[tet[1]*3 + 2];
        const z3 = vertices[tet[2]*3 + 2];
        const z4 = vertices[tet[3]*3 + 2];
        const cZ = (z1 + z2 + z3 + z4) / 4;
        
        // Show if centroid is below clipZ (visual Y is up in ThreeJS, but usually Z is up in CAD. 
        // Assuming vertices come in as [x, y, z] from rust).
        // Adjust coordinate system if necessary. Based on previous code, 
        // geometry seems to be loaded directly. Let's assume Z is height.
        return cZ <= clipZ;
    });

    filteredIndices.forEach(tet => {
      // 4 vertices of the tetrahedron
      const v0 = new THREE.Vector3(vertices[tet[0]*3], vertices[tet[0]*3+1], vertices[tet[0]*3+2]);
      const v1 = new THREE.Vector3(vertices[tet[1]*3], vertices[tet[1]*3+1], vertices[tet[1]*3+2]);
      const v2 = new THREE.Vector3(vertices[tet[2]*3], vertices[tet[2]*3+1], vertices[tet[2]*3+2]);
      const v3 = new THREE.Vector3(vertices[tet[3]*3], vertices[tet[3]*3+1], vertices[tet[3]*3+2]);

      // Calculate Centroid
      const c = new THREE.Vector3().add(v0).add(v1).add(v2).add(v3).multiplyScalar(0.25);

      // Shrink vertices towards centroid
      const s0 = new THREE.Vector3().lerpVectors(v0, c, 1 - shrinkFactor);
      const s1 = new THREE.Vector3().lerpVectors(v1, c, 1 - shrinkFactor);
      const s2 = new THREE.Vector3().lerpVectors(v2, c, 1 - shrinkFactor);
      const s3 = new THREE.Vector3().lerpVectors(v3, c, 1 - shrinkFactor);

      // Push 4 faces (12 vertices)
      // Face 0: 0-2-1
      posAttribute.push(s0.x, s0.y, s0.z, s2.x, s2.y, s2.z, s1.x, s1.y, s1.z);
      // Face 1: 0-1-3
      posAttribute.push(s0.x, s0.y, s0.z, s1.x, s1.y, s1.z, s3.x, s3.y, s3.z);
      // Face 2: 0-3-2
      posAttribute.push(s0.x, s0.y, s0.z, s3.x, s3.y, s3.z, s2.x, s2.y, s2.z);
      // Face 3: 1-2-3
      posAttribute.push(s1.x, s1.y, s1.z, s2.x, s2.y, s2.z, s3.x, s3.y, s3.z);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posAttribute, 3));
    geo.computeVertexNormals();
    return geo;
  }, [mesh, shrinkFactor, clipZ, color]); // Recalculate when clipZ changes

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial 
        color={color} 
        flatShading={true} 
        roughness={0.5} 
        side={THREE.DoubleSide} 
      />
    </mesh>
  );
}