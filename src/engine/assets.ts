// Asset loading with a cache keyed by absolute URL: a seek that rebuilds an entity
// never downloads or parses the same file twice.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import dracoWrapperUrl from "three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url";
import dracoWasmUrl from "three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url";
import type * as SparkNS from "@sparkjsdev/spark";

let gltfLoader: GLTFLoader | null = null;

function loader(): GLTFLoader {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader();
  // DRACOLoader fetches fixed file names from a folder; hand it the bundled copies.
  const files: Record<string, string> = { "draco_wasm_wrapper.js": dracoWrapperUrl, "draco_decoder.wasm": dracoWasmUrl };
  const d = draco as unknown as { _loadLibrary(url: string, type: string): Promise<unknown> };
  d._loadLibrary = (url: string, type: string) => {
    const l = new THREE.FileLoader();
    l.setResponseType(type);
    return l.loadAsync(files[url] ?? url);
  };
  gltfLoader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return gltfLoader;
}

const gltfCache = new Map<string, Promise<GLTF>>();

export function loadGLTF(url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = loader().loadAsync(url);
    p.catch(() => gltfCache.delete(url));
    gltfCache.set(url, p);
  }
  return p;
}

/** An independent copy of a loaded model (skinned meshes keep their own skeletons). */
export function instantiate(gltf: GLTF): THREE.Object3D {
  return cloneSkinned(gltf.scene);
}

type Spark = typeof SparkNS;
let sparkModule: Promise<Spark> | null = null;
export function spark(): Promise<Spark> {
  return (sparkModule ??= import("@sparkjsdev/spark"));
}

const splatCache = new Map<string, Promise<SparkNS.PackedSplats>>();

/** Parsed splat data shared by every SplatMesh that shows the same file. */
export function loadSplats(url: string): Promise<SparkNS.PackedSplats> {
  let p = splatCache.get(url);
  if (!p) {
    p = spark().then(async (S) => {
      const fileName = new URL(url).pathname.split("/").pop() ?? "splat";
      const packed = new S.PackedSplats({ url, fileName });
      await packed.initialized;
      return packed;
    });
    p.catch(() => splatCache.delete(url));
    splatCache.set(url, p);
  }
  return p;
}
