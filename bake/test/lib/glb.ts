import { MeshoptDecoder } from "meshoptimizer/decoder";

/**
 * A small GLB reader for tests: decodes meshopt views and accessors the way a
 * loader does, with no code shared with the writer.
 */

export interface ParsedGlb {
  json: any;
  bin: Uint8Array;
  views: Uint8Array[];
}

export async function readGlb(file: Uint8Array): Promise<ParsedGlb> {
  await MeshoptDecoder.ready;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  if (dv.getUint32(8, true) !== file.byteLength) throw new Error("GLB length does not match its header");
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLen)));
  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  const bin = file.subarray(binAt + 8, binAt + 8 + binLen);
  const views: Uint8Array[] = [];
  for (const v of json.bufferViews ?? []) {
    const e = v.extensions?.EXT_meshopt_compression;
    if (!e) throw new Error("view without meshopt");
    const target = new Uint8Array(e.count * e.byteStride);
    MeshoptDecoder.decodeGltfBuffer(target, e.count, e.byteStride, bin.subarray(e.byteOffset, e.byteOffset + e.byteLength), e.mode, e.filter ?? "NONE");
    views.push(target);
  }
  return { json, bin, views };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Accessor values as plain numbers, normalized ints expanded per the glTF spec. */
export function readAccessor(g: ParsedGlb, index: number): { values: Float64Array; size: number; count: number } {
  const a = g.json.accessors[index];
  const size = COMPONENTS[a.type]!;
  const view = g.views[a.bufferView]!;
  const def = g.json.bufferViews[a.bufferView];
  const stride = def.extensions.EXT_meshopt_compression.byteStride as number;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const out = new Float64Array(a.count * size);
  const start = a.byteOffset ?? 0;
  const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as 5120]!;
  // Vertex views may pad each element; animation views are tightly packed.
  const step = def.byteStride ?? bytes * size;
  void stride;
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < size; c++) {
      const p = start + i * step + c * bytes;
      let v: number;
      switch (a.componentType) {
        case 5120:
          v = dv.getInt8(p);
          if (a.normalized) v = Math.max(v / 127, -1);
          break;
        case 5121:
          v = dv.getUint8(p);
          if (a.normalized) v = v / 255;
          break;
        case 5122:
          v = dv.getInt16(p, true);
          if (a.normalized) v = Math.max(v / 32767, -1);
          break;
        case 5123:
          v = dv.getUint16(p, true);
          if (a.normalized) v = v / 65535;
          break;
        case 5125:
          v = dv.getUint32(p, true);
          break;
        case 5126:
          v = dv.getFloat32(p, true);
          break;
        default:
          throw new Error(`component type ${a.componentType}`);
      }
      out[i * size + c] = v;
    }
  }
  return { values: out, size, count: a.count };
}

/** One clip decoded, evaluated the way three's mixer does: linear, and slerp for rotations. */
export class ClipReader {
  private tracks = new Map<string, { times: Float64Array; values: Float64Array; size: number }>();

  constructor(g: ParsedGlb) {
    const a = g.json.animations[0];
    for (const ch of a.channels) {
      const s = a.samplers[ch.sampler];
      const times = readAccessor(g, s.input);
      const out = readAccessor(g, s.output);
      const name = g.json.nodes[ch.target.node].name as string;
      this.tracks.set(`${name}.${ch.target.path}`, { times: times.values, values: out.values, size: out.size });
    }
  }

  has(bone: number, path: string): boolean {
    return this.tracks.has(`b${bone}.${path}`);
  }

  private at(bone: number, path: string, t: number, rest: number[]): number[] {
    const tr = this.tracks.get(`b${bone}.${path}`);
    if (!tr) return rest;
    const { times, values, size } = tr;
    const n = times.length;
    const get = (i: number) => Array.from(values.subarray(i * size, (i + 1) * size));
    if (n === 1 || t <= times[0]!) return get(0);
    if (t >= times[n - 1]!) return get(n - 1);
    let lo = 0;
    while (lo < n - 2 && times[lo + 1]! <= t) lo++;
    const f = (t - times[lo]!) / (times[lo + 1]! - times[lo]!);
    const a = get(lo);
    const b = get(lo + 1);
    if (path === "rotation") return slerp(a, b, f);
    return a.map((v, c) => v + (b[c]! - v) * f);
  }

  /** The bone's local matrix at t seconds, column-major. */
  local(bone: number, t: number): number[] {
    return trs(this.at(bone, "translation", t, [0, 0, 0]), this.at(bone, "rotation", t, [0, 0, 0, 1]), this.at(bone, "scale", t, [1, 1, 1]));
  }
}

function slerp(a: number[], b: number[], f: number): number[] {
  let dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let k0: number;
  let k1: number;
  if (dot > 0.9995) {
    k0 = 1 - f;
    k1 = f;
  } else {
    const th = Math.acos(dot);
    const s = Math.sin(th);
    k0 = Math.sin((1 - f) * th) / s;
    k1 = Math.sin(f * th) / s;
  }
  const out = a.map((v, c) => v * k0 + sign * b[c]! * k1);
  const len = Math.hypot(...out);
  return out.map((v) => v / len);
}

export function trs(t: number[], q: number[], s: number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  return [r00 * sx, r10 * sx, r20 * sx, 0, r01 * sy, r11 * sy, r21 * sy, 0, r02 * sz, r12 * sz, r22 * sz, 0, t[0]!, t[1]!, t[2]!, 1];
}

export function mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = v;
    }
  }
  return out;
}

export function apply(m: number[], p: number[]): number[] {
  const [x, y, z] = p as [number, number, number];
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

/** World matrices of every bone from the parent table. */
export function worldMatrices(parents: number[], local: (b: number) => number[]): number[][] {
  const out: (number[] | undefined)[] = new Array(parents.length);
  const get = (b: number): number[] => {
    const hit = out[b];
    if (hit) return hit;
    const l = local(b);
    const p = parents[b]!;
    const w = p >= 0 ? mul(get(p), l) : l;
    out[b] = w;
    return w;
  };
  parents.forEach((_p, b) => get(b));
  return out as number[][];
}

/**
 * A retail-space matrix (top three rows, row-major) in target space: P M P^-1 with
 * (x, y, z) -> (y, z, x). Returned column-major, to compare with the baked one.
 */
export function retailToTarget(m: number[]): number[] {
  const at = (r: number, c: number) => m[r * 4 + c]!;
  // Target axis i is retail axis map[i]: x' = y, y' = z, z' = x.
  const map = [1, 2, 0];
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[j * 4 + i] = at(map[i]!, map[j]!);
    out[12 + i] = at(map[i]!, 3);
  }
  out[15] = 1;
  return out;
}
