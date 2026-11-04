import { MeshoptEncoder } from "meshoptimizer/encoder";

/**
 * A minimal GLB writer with EXT_meshopt_compression. Hand-written rather than
 * gltfpack because the contract needs things it would change:
 *  - every submesh stays one primitive with its own material, over one shared
 *    vertex stream (gltfpack would re-partition the vertices per primitive);
 *  - inverse bind matrices stay identity (its skinned quantization moves the
 *    position scale into them);
 *  - UVs outside [0, 1] stay floats (its quantized UVs need KHR_texture_transform,
 *    which our custom shaders would have to reimplement).
 * It also produces the same bytes for the same input, and JSON with nothing a
 * loader doesn't read: on a clip, the JSON is a large share of the file.
 *
 * The vertex codec is always version 0: EXT_meshopt_compression and the decoder
 * in three r180 know only that one, and the library's default is version 1.
 */

export const C_BYTE = 5120;
export const C_UBYTE = 5121;
export const C_SHORT = 5122;
export const C_USHORT = 5123;
export const C_UINT = 5125;
export const C_FLOAT = 5126;

export const T_ARRAY = 34962;
export const T_INDEX = 34963;

type Mode = "ATTRIBUTES" | "TRIANGLES";
type Filter = "NONE" | "OCTAHEDRAL" | "QUATERNION" | "EXPONENTIAL";

export async function encoderReady(): Promise<void> {
  await MeshoptEncoder.ready;
}

interface AccessorDef {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: "SCALAR" | "VEC2" | "VEC3" | "VEC4";
  min?: number[];
  max?: number[];
}

export class GlbWriter {
  readonly json: Record<string, unknown> & {
    bufferViews: unknown[];
    accessors: AccessorDef[];
  };
  private readonly bin: Uint8Array[] = [];
  private binLength = 0;
  private decodedLength = 0;

  constructor(generator = "eclipse-bake", usesQuantization = false) {
    const ext = ["EXT_meshopt_compression", ...(usesQuantization ? ["KHR_mesh_quantization"] : [])];
    this.json = {
      asset: { version: "2.0", generator },
      extensionsUsed: ext,
      extensionsRequired: ext,
      bufferViews: [],
      accessors: [],
    };
  }

  /**
   * `data` is the view's bytes after any filter. `stride` must be a multiple of 4.
   * `vertexStride` writes byteStride on the view: needed for attributes, and not
   * allowed on animation data.
   */
  view(data: Uint8Array, count: number, stride: number, opts: { mode?: Mode; filter?: Filter; target?: number; vertexStride?: boolean } = {}): number {
    const mode = opts.mode ?? "ATTRIBUTES";
    const encoded =
      mode === "ATTRIBUTES" ? MeshoptEncoder.encodeVertexBufferLevel(data, count, stride, 3, 0) : MeshoptEncoder.encodeGltfBuffer(data, count, stride, mode, 0);
    const pad = (4 - (this.binLength % 4)) % 4;
    if (pad) {
      this.bin.push(new Uint8Array(pad));
      this.binLength += pad;
    }
    const ext: Record<string, unknown> = { buffer: 0, byteOffset: this.binLength, byteLength: encoded.length, byteStride: stride, mode, count };
    if (opts.filter && opts.filter !== "NONE") ext.filter = opts.filter;
    this.bin.push(encoded);
    this.binLength += encoded.length;

    const decodedPad = (4 - (this.decodedLength % 4)) % 4;
    this.decodedLength += decodedPad;
    const view: Record<string, unknown> = { buffer: 1, byteOffset: this.decodedLength, byteLength: data.length };
    if (opts.vertexStride) view.byteStride = stride;
    if (opts.target) view.target = opts.target;
    view.extensions = { EXT_meshopt_compression: ext };
    this.decodedLength += data.length;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  accessor(def: AccessorDef): number {
    const clean: AccessorDef = { ...def };
    if (!clean.byteOffset) delete clean.byteOffset;
    this.json.accessors.push(clean);
    return this.json.accessors.length - 1;
  }

  toBuffer(): Buffer {
    this.json.buffers = [{ byteLength: this.binLength }, { byteLength: this.decodedLength, extensions: { EXT_meshopt_compression: { fallback: true } } }];
    let text = Buffer.from(JSON.stringify(this.json), "utf8");
    const jsonPad = (4 - (text.length % 4)) % 4;
    if (jsonPad) text = Buffer.concat([text, Buffer.alloc(jsonPad, 0x20)]);
    const binPad = (4 - (this.binLength % 4)) % 4;
    const binTotal = this.binLength + binPad;
    const total = 12 + 8 + text.length + 8 + binTotal;
    const head = Buffer.alloc(12 + 8);
    head.write("glTF", 0, "latin1");
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(total, 8);
    head.writeUInt32LE(text.length, 12);
    head.write("JSON", 16, "latin1");
    const binHead = Buffer.alloc(8);
    binHead.writeUInt32LE(binTotal, 0);
    binHead.write("BIN\0", 4, "latin1");
    return Buffer.concat([head, text, binHead, ...this.bin, Buffer.alloc(binPad)]);
  }
}

export function asBytes(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}
