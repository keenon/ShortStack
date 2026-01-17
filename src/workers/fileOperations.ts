import * as THREE from "three";
import { STLLoader, OBJLoader, GLTFLoader, GLTFExporter } from "three-stdlib";
import { mergeBufferGeometries, mergeVertices } from "three-stdlib";
import { base64ToArrayBuffer, arrayBufferToBase64 } from "./meshUtils";

export async function loadMesh(id: string, payload: any, report: (msg: string, pct: number) => void): Promise<any> {
    const { content, format, name } = payload;
    const meshName = name || "mesh";

    report(`Loading mesh ${meshName} (1/2)...`, 0.1);

    const buffer = base64ToArrayBuffer(content);
    let geometry: THREE.BufferGeometry | null = null;
    
    if (format === "stl") {
        const loader = new STLLoader();
        geometry = loader.parse(buffer);
    } else if (format === "obj") {
        const text = new TextDecoder().decode(buffer);
        const loader = new OBJLoader();
        const group = loader.parse(text);
        const geoms: THREE.BufferGeometry[] = [];
        group.traverse((c: any) => { if(c.isMesh) geoms.push(c.geometry); });
        if(geoms.length) geometry = mergeBufferGeometries(geoms);
    } else if (format === "glb") {
        const loader = new GLTFLoader();
        await new Promise<void>((resolve, reject) => {
            loader.parse(buffer, "", (gltf) => {
                const geoms: THREE.BufferGeometry[] = [];
                gltf.scene.traverse((c: any) => { if(c.isMesh) geoms.push(c.geometry); });
                if(geoms.length) geometry = mergeBufferGeometries(geoms);
                resolve();
            }, reject);
        });
    }

    report(`Optimizing mesh ${meshName} (2/2)...`, 0.8);

    if (geometry) {
        const nonIndexed = geometry.toNonIndexed();
        const indexed = mergeVertices(nonIndexed);
        
        report(`Loaded ${meshName}`, 1.0);

        self.postMessage({ 
            id, type: "success", 
            payload: { 
                position: indexed.getAttribute('position').array,
                normal: indexed.getAttribute('normal')?.array,
                index: indexed.getIndex()?.array
            } 
        });
    } else {
        throw new Error("Failed to load geometry");
    }
}

export async function convertFile(id: string, payload: any, occt: any, report: (msg: string, pct: number) => void): Promise<any> {
    const { buffer, format, fileName } = payload;
    let geometry: THREE.BufferGeometry | null = null;
    
    report("Reading file...", 0.1);

    if (format === "stl") {
        const loader = new STLLoader();
        geometry = loader.parse(buffer);
    } else if (format === "obj") {
        const text = new TextDecoder().decode(buffer);
        const loader = new OBJLoader();
        const group = loader.parse(text);
        const geometries: THREE.BufferGeometry[] = [];
        group.traverse((child: any) => { if (child.isMesh) geometries.push(child.geometry); });
        if (geometries.length > 0) geometry = mergeBufferGeometries(geometries);
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
            const base64 = arrayBufferToBase64(buffer);
            report("Complete", 1.0);
            self.postMessage({ id, type: "success", payload: { base64, format: "glb" } });
            return;
    }

    if (!geometry) {
        throw new Error(`Failed to parse geometry for ${fileName} (${format})`);
    }

    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const exporter = new GLTFExporter();
    
    report("Converting to GLB...", 0.8);

    exporter.parse(
        mesh,
        (gltf) => {
            if (gltf instanceof ArrayBuffer) {
                const base64 = arrayBufferToBase64(gltf);
                report("Complete", 1.0);
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
    
    return Promise.resolve();
}
