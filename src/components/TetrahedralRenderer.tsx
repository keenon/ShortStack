// src/components/TetrahedralRenderer.tsx
import { useMemo, useRef } from "react";
import * as THREE from "three";

interface Props {
  mesh: { vertices: number[]; indices: number[][] }; 
  shrinkFactor: number;
  color: string;
  clipZ: number; 
  minZ: number; 
}

export default function TetrahedralRenderer({ mesh, shrinkFactor, color, clipZ }: Props) {
  const geometry = useMemo(() => {
    const indices = mesh.indices;
    const vertices = mesh.vertices;
    
    const posAttribute: number[] = [];

    // Helper to get Vector3 from vertex index
    const getV = (i: number) => 
      new THREE.Vector3(vertices[i*3], vertices[i*3+1], vertices[i*3+2]);

    indices.forEach(element => {
      // 1. Calculate Centroid & Check Clipping
      let c = new THREE.Vector3();
      let zSum = 0;
      
      const numNodes = element.length;
      
      for(let i=0; i<numNodes; i++) {
        zSum += vertices[element[i]*3 + 2];
      }
      
      const centroidZ = zSum / numNodes;
      if (centroidZ > clipZ) return; // Clip

      // 2. Build Vectors & Calculate Spatial Centroid
      const verts: THREE.Vector3[] = [];
      for(let i=0; i<numNodes; i++) {
        const v = getV(element[i]);
        verts.push(v);
        c.add(v);
      }
      c.multiplyScalar(1.0 / numNodes);

      // 3. Shrink Vertices
      const s = verts.map(v => new THREE.Vector3().lerpVectors(v, c, 1 - shrinkFactor));

      // 4. Generate Faces
      if (numNodes === 3) {
        // --- Triangle (2D Mesh) ---
        // Just one face: 0-1-2
        posAttribute.push(s[0].x, s[0].y, s[0].z, s[1].x, s[1].y, s[1].z, s[2].x, s[2].y, s[2].z);
      } 
      else if (numNodes === 4) {
        // --- Tetrahedron (3D Mesh) ---
        // Face 0: 0-2-1 (Bottom/Side) - Winding order matters for culling, but we use DoubleSide
        posAttribute.push(s[0].x, s[0].y, s[0].z, s[2].x, s[2].y, s[2].z, s[1].x, s[1].y, s[1].z);
        // Face 1: 0-1-3
        posAttribute.push(s[0].x, s[0].y, s[0].z, s[1].x, s[1].y, s[1].z, s[3].x, s[3].y, s[3].z);
        // Face 2: 0-3-2
        posAttribute.push(s[0].x, s[0].y, s[0].z, s[3].x, s[3].y, s[3].z, s[2].x, s[2].y, s[2].z);
        // Face 3: 1-2-3
        posAttribute.push(s[1].x, s[1].y, s[1].z, s[2].x, s[2].y, s[2].z, s[3].x, s[3].y, s[3].z);
      }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posAttribute, 3));
    geo.computeVertexNormals();
    return geo;
  }, [mesh, shrinkFactor, clipZ]);

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