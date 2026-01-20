import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Edges } from '@react-three/drei';

interface TetMeshResult {
  vertices: [number, number, number][];
  surface_indices: number[]; 
}

interface Props {
  mesh: TetMeshResult;
  color?: string;
  threshold?: number; // Allow dynamic threshold
}

export default function SurfaceRenderer({ mesh, color = "#ff6b6b", threshold = 15 }: Props) {
  
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const flatVerts = new Float32Array(mesh.vertices.flat());
    
    geo.setAttribute('position', new THREE.BufferAttribute(flatVerts, 3));
    geo.setIndex(mesh.surface_indices);
    
    // Compute normals so lighting works
    geo.computeVertexNormals();
    
    return geo;
  }, [mesh]);

  return (
    <group>
        {/* 1. The Solid Surface */}
        <mesh geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial 
            color={color} 
            roughness={0.5} 
            metalness={0.0}
            side={THREE.DoubleSide}
            
            // FIX Z-FIGHTING:
            // Push the pink pixels 'back' into the screen slightly.
            // This lets the black lines (drawn at depth 0) win the depth test.
            polygonOffset={true}
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>

        {/* 2. The Black Outlines */}
        {/* We use the same geometry, no scaling needed anymore */}
        <mesh geometry={geometry}>
            <Edges 
                // key ensures the component re-runs immediately when threshold changes
                key={`${threshold}-${mesh.surface_indices.length}`} 
                threshold={threshold} 
                color="#000000" 
                linewidth={1} 
            />
             {/* Invisible material just to satisfy the mesh requirement, though Edges handles the rendering */}
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
    </group>
  );
}