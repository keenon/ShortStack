// src/workers/meshWorker.ts
// POLYFILLS FOR WORKER ENVIRONMENT
self.window = self as any;
self.document = {
    createElement: (tag: string) => {
        if (tag === 'canvas') {
            // Minimal canvas mock for three-stdlib if needed
            // OffscreenCanvas is available in workers in modern browsers
            if (typeof OffscreenCanvas !== 'undefined') {
                return new OffscreenCanvas(1, 1);
            }
            return {
                getContext: () => null,
                toDataURL: () => ""
            };
        }
        if (tag === 'img') {
             return { src: "", width: 0, height: 0 };
        }
        return {};
    },
    createElementNS: (_ns: string, tag: string) => (self.document as any).createElement(tag)
} as any;

import * as THREE from "three";
import { STLLoader, OBJLoader, GLTFExporter } from "three-stdlib";
import { mergeBufferGeometries } from "three-stdlib";
// @ts-ignore
import initOCCT from "occt-import-js";

let occt: any = null;

// Helper to convert ArrayBuffer to Base64 (Chunked to avoid stack overflow)
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunk = 8192; // Safe chunk size
    for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + chunk, len))));
    }
    return self.btoa(binary);
}

self.onmessage = async (e: MessageEvent) => {
    const { id, type, payload } = e.data;

    try {
        if (type === "init") {
            if (!occt) {
                // Initialize OCCT with the provided WASM URL from main thread
                // Note: initOCCT default export is a function
                occt = await initOCCT({
                    locateFile: () => payload.wasmUrl
                });
            }
            self.postMessage({ id, type: "success", payload: "initialized" });
            return;
        }

        if (type === "convert") {
            const { buffer, format, fileName } = payload;
            let geometry: THREE.BufferGeometry | null = null;

            // 1. Parse Input Format
            if (format === "stl") {
                const loader = new STLLoader();
                geometry = loader.parse(buffer);
            } else if (format === "obj") {
                const text = new TextDecoder().decode(buffer);
                const loader = new OBJLoader();
                const group = loader.parse(text);
                const geometries: THREE.BufferGeometry[] = [];
                group.traverse((child: any) => {
                    if (child.isMesh) geometries.push(child.geometry);
                });
                if (geometries.length > 0) {
                     geometry = mergeBufferGeometries(geometries);
                }
            } else if (format === "step" || format === "stp") {
                if (!occt) throw new Error("OCCT not initialized");
                
                const fileBytes = new Uint8Array(buffer);
                const result = occt.ReadStepFile(fileBytes, null);
                
                if (result && result.meshes && result.meshes.length > 0) {
                    const geometries: THREE.BufferGeometry[] = [];
                    for(const m of result.meshes) {
                        const geom = new THREE.BufferGeometry();
                        const positions = new Float32Array(m.attributes.position.array);
                        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                        
                        if(m.attributes.normal) {
                             const normals = new Float32Array(m.attributes.normal.array);
                             geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
                        }
                        
                        if(m.index) {
                            const indices = new Uint16Array(m.index.array);
                            geom.setIndex(new THREE.BufferAttribute(indices, 1));
                        }
                        geometries.push(geom);
                    }
                    geometry = mergeBufferGeometries(geometries);
                }
            } else if (format === "glb" || format === "gltf") {
                 // Pass through if already GLB
                 const base64 = arrayBufferToBase64(buffer);
                 self.postMessage({ id, type: "success", payload: { base64, format: "glb" } });
                 return;
            }

            if (!geometry) {
                throw new Error(`Failed to parse geometry for ${fileName} (${format})`);
            }

            // 2. Export to GLB
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            const exporter = new GLTFExporter();

            exporter.parse(
                mesh,
                (gltf) => {
                    if (gltf instanceof ArrayBuffer) {
                        const base64 = arrayBufferToBase64(gltf);
                        self.postMessage({ id, type: "success", payload: { base64, format: "glb" } });
                    } else {
                        self.postMessage({ id, type: "error", error: "GLTF Exporter returned JSON" });
                    }
                },
                (err) => {
                    self.postMessage({ id, type: "error", error: err.message });
                },
                { binary: true }
            );
        }

    } catch (err: any) {
        self.postMessage({ id, type: "error", error: err.message || "Unknown worker error" });
    }
};