// src/workers/meshWorker.ts
// --- POLYFILLS FOR WORKER ENVIRONMENT ---
self.window = self as any;
self.document = {
    createElement: (tag: string) => {
        if (tag === 'canvas') {
            if (typeof OffscreenCanvas !== 'undefined') {
                return new OffscreenCanvas(1, 1);
            }
            return {
                getContext: () => null,
                toDataURL: () => ""
            };
        }
        if (tag === 'img') return { src: "", width: 0, height: 0 };
        return {};
    },
    createElementNS: (_ns: string, tag: string) => (self.document as any).createElement(tag)
} as any;

// @ts-ignore
import initOCCT from "occt-import-js";
import Module from "manifold-3d";
import { computeLayer, computeUnionOutline } from "./layerOperations";
import { loadMesh, convertFile } from "./fileOperations";
import { computeToolpath } from "./toolpathOperations";

let occt: any = null;
let manifoldModule: any = null;

self.onmessage = async (e: MessageEvent) => {
    const { id, type, payload } = e.data;

    const report = (msg: string, percent: number) => {
        self.postMessage({ 
            type: "progress", 
            id, 
            payload: { 
                message: msg, 
                percent,
                layerIndex: payload.layerIndex 
            } 
        });
    };

    try {
        if (type === "init") {
            if (payload.occtWasmUrl && !occt) {
                occt = await initOCCT({ locateFile: () => payload.occtWasmUrl });
            }
            if (payload.manifoldWasmUrl && !manifoldModule) {
                Module({
                    locateFile: ((path: string) => path.endsWith('.wasm') ? payload.manifoldWasmUrl : path) as any
                }).then((m) => {
                    m.setup();
                    manifoldModule = m;
                    self.postMessage({ id, type: "success", payload: "initialized" });
                });
                return;
            }
            self.postMessage({ id, type: "success", payload: "initialized" });
        }
        
        else if (type === "loadMesh") {
             await loadMesh(id, payload, report);
        }
        
        else if (type === "computeLayer") {
            computeLayer(id, payload, manifoldModule, report);
        }

        else if (type === "computeUnionOutline") {
            computeUnionOutline(id, payload, manifoldModule);
        }
        
        else if (type === "convert") {
            await convertFile(id, payload, occt, report);
        }
        
        else if (type === "computeToolpath") {
            computeToolpath(id, payload, manifoldModule);
        }

    } catch (err: any) {
        self.postMessage({ id, type: "error", error: err.message || "Unknown worker error" });
    }
};
