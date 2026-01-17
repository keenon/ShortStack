import React, { useMemo } from 'react';
import * as THREE from 'three';

interface TetMeshResult {
  vertices: [number, number, number][];
  indices: number[]; // Flat array, 4 per tet
}

interface Props {
  mesh: TetMeshResult;
  shrinkFactor?: number; // 0.0 to 1.0 (0.8 is good)
  color?: string;
}

export default function TetrahedralRenderer({ mesh, shrinkFactor = 0.8, color = "#ff6b6b" }: Props) {
  
  const geometry = useMemo(() => {
    const numTets = mesh.indices.length / 4;
    const positionBuffer = new Float32Array(numTets * 4 * 3 * 3); // 4 faces * 3 verts * 3 coords
    const normalBuffer = new Float32Array(numTets * 4 * 3 * 3);

    const _v0 = new THREE.Vector3();
    const _v1 = new THREE.Vector3();
    const _v2 = new THREE.Vector3();
    const _v3 = new THREE.Vector3();
    const _centroid = new THREE.Vector3();
    
    // Temp vectors for triangle calc
    const _cb = new THREE.Vector3();
    const _ab = new THREE.Vector3();

    let ptr = 0;

    const pushTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
      // Calculate flat normal
      _cb.subVectors(c, b);
      _ab.subVectors(a, b);
      _cb.cross(_ab).normalize(); 

      // Push A
      positionBuffer[ptr] = a.x; positionBuffer[ptr+1] = a.y; positionBuffer[ptr+2] = a.z;
      normalBuffer[ptr] = _cb.x; normalBuffer[ptr+1] = _cb.y; normalBuffer[ptr+2] = _cb.z;
      ptr += 3;

      // Push B
      positionBuffer[ptr] = b.x; positionBuffer[ptr+1] = b.y; positionBuffer[ptr+2] = b.z;
      normalBuffer[ptr] = _cb.x; normalBuffer[ptr+1] = _cb.y; normalBuffer[ptr+2] = _cb.z;
      ptr += 3;

      // Push C
      positionBuffer[ptr] = c.x; positionBuffer[ptr+1] = c.y; positionBuffer[ptr+2] = c.z;
      normalBuffer[ptr] = _cb.x; normalBuffer[ptr+1] = _cb.y; normalBuffer[ptr+2] = _cb.z;
      ptr += 3;
    };

    for (let i = 0; i < numTets; i++) {
      const idx0 = mesh.indices[i*4 + 0];
      const idx1 = mesh.indices[i*4 + 1];
      const idx2 = mesh.indices[i*4 + 2];
      const idx3 = mesh.indices[i*4 + 3];

      const p0 = mesh.vertices[idx0];
      const p1 = mesh.vertices[idx1];
      const p2 = mesh.vertices[idx2];
      const p3 = mesh.vertices[idx3];

      _v0.set(p0[0], p0[1], p0[2]);
      _v1.set(p1[0], p1[1], p1[2]);
      _v2.set(p2[0], p2[1], p2[2]);
      _v3.set(p3[0], p3[1], p3[2]);

      // Calculate Centroid
      _centroid.set(0,0,0).add(_v0).add(_v1).add(_v2).add(_v3).multiplyScalar(0.25);

      // Shrink vertices towards centroid
      if (shrinkFactor < 1.0) {
        _v0.lerp(_centroid, 1.0 - shrinkFactor);
        _v1.lerp(_centroid, 1.0 - shrinkFactor);
        _v2.lerp(_centroid, 1.0 - shrinkFactor);
        _v3.lerp(_centroid, 1.0 - shrinkFactor);
      }

      // Tet Faces (0-2-1, 0-1-3, 1-2-3, 2-0-3)
      pushTriangle(_v0, _v2, _v1);
      pushTriangle(_v0, _v1, _v3);
      pushTriangle(_v1, _v2, _v3);
      pushTriangle(_v2, _v0, _v3);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positionBuffer, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normalBuffer, 3));
    return geom;

  }, [mesh, shrinkFactor]);

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial 
        color={color} 
        roughness={0.4} 
        metalness={0.1}
        flatShading={true} 
        side={THREE.DoubleSide} 
      />
    </mesh>
  );
}