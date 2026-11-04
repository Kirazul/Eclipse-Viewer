import { encodeToKTX2 } from "ktx2-encoder";
import type { Rgba } from "./blp";

/**
 * KTX2 with Basis, ETC1S. `ktx2-encoder`'s Node entry runs the official Basis
 * Universal encoder as WASM, so it behaves the same on Linux CI and on Windows with
 * nothing to install, and it stays in step with the transcoder three's KTX2Loader
 * ships. It wants an image decoder for encoded input; ours hands it raw RGBA we
 * already decoded from BLP.
 *
 * Top row first, no flip: M2 and glTF share the top-left UV origin.
 */

/** Basis ETC1S quality, 1-255. Not tuned yet: the spec's texel gate should decide it. */
export const ETC1S_QUALITY = 128;

/**
 * The WASM encoder prints its progress to stdout whatever the debug flag says, a
 * dozen lines per mip. Run logs are for people, so stdout is quiet while it works.
 */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await work();
  } finally {
    process.stdout.write = write;
  }
}

export async function encodeKtx2(img: Rgba, opts: { quality?: number } = {}): Promise<Uint8Array> {
  return quietly(() =>
    encodeToKTX2(new Uint8Array(1), {
      enableDebug: false,
      isUASTC: false,
      isKTX2File: true,
      generateMipmap: true,
      qualityLevel: opts.quality ?? ETC1S_QUALITY,
      compressionLevel: 2,
      isPerceptual: true,
      isSetKTX2SRGBTransferFunc: true,
      imageDecoder: async () => ({ width: img.width, height: img.height, data: img.data }),
    }),
  );
}
