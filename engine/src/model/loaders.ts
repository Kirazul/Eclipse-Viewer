/**
 * The three.js loaders, one of each per page. Meshopt decoding runs on workers and
 * Basis transcoding on KTX2Loader's own, so parsing a pack leaves the main thread
 * free. The transcoder files are served from /basis/ (engine/scripts/copy-basis.mjs).
 */
import { DataTexture, NoColorSpace, RGBAFormat, SkinnedMesh, type AnimationClip, type Texture, type WebGLRenderer } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import type { ClipEntry } from "@eclipse/format";
import { unbakeTranslations } from "../logic/pivots";

export const TRANSCODER_PATH = "/basis/";

/**
 * GLTFLoader renormalizes every skinned vertex on the main thread, tens of
 * milliseconds on a body. Retail's weights are u8 summing to 255, and the baker's GLB
 * keeps them, so that work changes nothing here.
 */
SkinnedMesh.prototype.normalizeSkinWeights = function (): void {};

let gltf: GLTFLoader | null = null;
let ktx2: KTX2Loader | null = null;
let white: DataTexture | null = null;

function gltfLoader(): GLTFLoader {
  if (!gltf) {
    gltf = new GLTFLoader();
    gltf.setMeshoptDecoder(MeshoptDecoder as never);
    // Keeps decode off the main thread. No-op where workers are unavailable.
    MeshoptDecoder.useWorkers(2);
  }
  return gltf;
}

export function ktx2Loader(renderer: WebGLRenderer): KTX2Loader {
  if (!ktx2) {
    ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH).setWorkerLimit(2).detectSupport(renderer);
    // Eager, as a first frame needs it and the wasm is cached immutably.
    ktx2.init();
  }
  return ktx2;
}

export function parseGlb(buffer: ArrayBuffer): Promise<GLTF> {
  return gltfLoader().parseAsync(buffer, "");
}

export async function parseClip(buffer: ArrayBuffer, entry: ClipEntry, pivots?: readonly number[]): Promise<AnimationClip> {
  const parsed = await parseGlb(buffer);
  const clip = parsed.animations[0];
  if (!clip) throw new Error(`clip ${entry.id} holds no animation`);
  clip.name = entry.id;
  if (entry.durationMs > 0) clip.duration = entry.durationMs / 1000;
  if (pivots) unbakeTranslations(clip.tracks as never, pivots);
  return clip;
}

/** A gamma-space, unflipped, tier-capped texture from KTX2 bytes. */
export function parseTexture(renderer: WebGLRenderer, buffer: ArrayBuffer, anisotropy: number): Promise<Texture> {
  return new Promise((resolve, reject) => {
    ktx2Loader(renderer).parse(
      buffer,
      (texture) => {
        texture.flipY = false;
        texture.colorSpace = NoColorSpace;
        texture.anisotropy = anisotropy;
        resolve(texture);
      },
      reject,
    );
  });
}

/** Stands in for an empty texture unit. */
export function whiteTexture(): DataTexture {
  if (!white) {
    white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    white.colorSpace = NoColorSpace;
    white.needsUpdate = true;
  }
  return white;
}
