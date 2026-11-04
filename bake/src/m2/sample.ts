import type { ClipBuffers, M2Model, Sequence, SkelLevel } from "./model";

/**
 * Evaluating an M2 track the way Eclipse's tools/lib/m2_view.py does, which is the
 * golden reference:
 *   compressed quaternion: (s < 0 ? s + 32768 : s - 32767) / 32767
 *   interpolation 0 holds the key; 1 and 2/3 interpolate (hermite and bezier keys
 *   are read as their value, as the client's linear fallback does for bones)
 *   a track on a global sequence runs on wall time modulo that loop
 */

export type ValueKind = "vec3" | "quat16" | "quatf" | "fixed16" | "f32" | "vec2";

const STRIDE: Record<ValueKind, number> = { vec3: 3, quat16: 4, quatf: 4, fixed16: 1, f32: 1, vec2: 2 };
const ELEM_BYTES: Record<ValueKind, number> = { vec3: 12, quat16: 8, quatf: 16, fixed16: 2, f32: 4, vec2: 8 };

export function q16(v: number): number {
  return (v < 0 ? v + 32768 : v - 32767) / 32767;
}

export interface TrackHeader {
  interp: number;
  gseq: number;
  /** Per-sequence (count, offset) tables, in the record's own buffer. */
  timesCount: number;
  timesAt: number;
  valuesCount: number;
  valuesAt: number;
}

export function readTrackHeader(buf: Buffer, o: number): TrackHeader {
  return {
    interp: buf.readUInt16LE(o),
    gseq: buf.readInt16LE(o + 2),
    timesCount: buf.readUInt32LE(o + 4),
    timesAt: buf.readUInt32LE(o + 8),
    valuesCount: buf.readUInt32LE(o + 12),
    valuesAt: buf.readUInt32LE(o + 16),
  };
}

export interface Keys {
  interp: number;
  times: Uint32Array;
  /** Flat, `stride` per key. Quat16 already expanded to floats. */
  values: Float64Array;
  stride: number;
}

export interface KeyStats {
  /** A `.anim` too short for what its record claims: no keys, the track holds. */
  short: number;
}

/**
 * The keys of track `h` for sequence `s`. `rec` holds the per-sequence tables and
 * `keyBuf` the arrays they point at, usually a `.anim` block. Null when the
 * sequence has no keys for this track.
 */
export function readKeys(rec: Buffer, h: TrackHeader, s: number, keyBuf: Buffer, kind: ValueKind, stats?: KeyStats): Keys | null {
  if (s >= h.timesCount || s >= h.valuesCount) return null;
  const n = rec.readUInt32LE(h.timesAt + s * 8);
  const tOff = rec.readUInt32LE(h.timesAt + s * 8 + 4);
  const vn = rec.readUInt32LE(h.valuesAt + s * 8);
  const vOff = rec.readUInt32LE(h.valuesAt + s * 8 + 4);
  if (n === 0 || vn === 0 || n !== vn) return null;
  if (keyBuf.length === 0) return null;
  const elem = ELEM_BYTES[kind];
  if (tOff + n * 4 > keyBuf.length || vOff + n * elem > keyBuf.length) {
    if (stats) stats.short++;
    return null;
  }
  const times = new Uint32Array(n);
  for (let i = 0; i < n; i++) times[i] = keyBuf.readUInt32LE(tOff + i * 4);
  const stride = STRIDE[kind];
  const values = new Float64Array(n * stride);
  for (let i = 0; i < n; i++) {
    const p = vOff + i * elem;
    switch (kind) {
      case "vec3":
        values[i * 3] = keyBuf.readFloatLE(p);
        values[i * 3 + 1] = keyBuf.readFloatLE(p + 4);
        values[i * 3 + 2] = keyBuf.readFloatLE(p + 8);
        break;
      case "vec2":
        values[i * 2] = keyBuf.readFloatLE(p);
        values[i * 2 + 1] = keyBuf.readFloatLE(p + 4);
        break;
      case "quat16":
        for (let c = 0; c < 4; c++) values[i * 4 + c] = q16(keyBuf.readInt16LE(p + c * 2));
        break;
      case "quatf":
        for (let c = 0; c < 4; c++) values[i * 4 + c] = keyBuf.readFloatLE(p + c * 4);
        break;
      case "fixed16":
        values[i] = keyBuf.readInt16LE(p) / 32767;
        break;
      case "f32":
        values[i] = keyBuf.readFloatLE(p);
        break;
    }
  }
  return { interp: h.interp, times, values, stride };
}

/** One track of a bone for one clip: its keys and the clock they run on. */
interface BoundTrack {
  keys: Keys | null;
  /** Global loop length in ms, or 0 for the clip's own clock. */
  loop: number;
  gseq: number;
}

function evalInto(tr: BoundTrack, tIn: number, isQuat: boolean, out: Float64Array): boolean {
  const k = tr.keys;
  if (!k) return false;
  let t = tIn;
  if (tr.gseq >= 0) t = tr.loop ? t % tr.loop : 0;
  const { times, values, stride } = k;
  const n = times.length;
  if (n === 1 || t <= times[0]!) {
    for (let c = 0; c < stride; c++) out[c] = values[c]!;
    return true;
  }
  if (t >= times[n - 1]!) {
    for (let c = 0; c < stride; c++) out[c] = values[(n - 1) * stride + c]!;
    return true;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = lo * stride;
  const b = (lo + 1) * stride;
  if (k.interp === 0) {
    for (let c = 0; c < stride; c++) out[c] = values[a + c]!;
    return true;
  }
  const f = (t - times[lo]!) / Math.max(1e-9, times[lo + 1]! - times[lo]!);
  if (isQuat) {
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += values[a + c]! * values[b + c]!;
    const sign = dot < 0 ? -1 : 1;
    let len = 0;
    for (let c = 0; c < 4; c++) {
      const v = values[a + c]! * (1 - f) + sign * values[b + c]! * f;
      out[c] = v;
      len += v * v;
    }
    len = Math.max(1e-9, Math.sqrt(len));
    for (let c = 0; c < 4; c++) out[c] = out[c]! / len;
    return true;
  }
  for (let c = 0; c < stride; c++) out[c] = values[a + c]! * (1 - f) + values[b + c]! * f;
  return true;
}

const OFF_TRANS = 16;
const OFF_ROT = 36;
const OFF_SCALE = 56;
const BONE_BYTES = 88;

function trackHasKeys(rec: Buffer, h: TrackHeader): boolean {
  for (let s = 0; s < h.timesCount; s++) if (rec.readUInt32LE(h.timesAt + s * 8) > 0) return true;
  return false;
}

/**
 * Which level's record drives this bone field for a sequence. Normally the
 * sequence's own. On a chained body, a field can be a global loop in one skeleton
 * and empty in the other, and then the global one is the bone's animation whatever
 * the sequence (m2model.py merge_records, measured on every chained body).
 */
function pickLevel(model: M2Model, seq: Sequence, bone: number, field: number): SkelLevel {
  const child = model.levels[0]!;
  const parent = model.levels[1];
  if (!parent) return seq.level;
  const at = (l: SkelLevel) => l.boneOff + bone * BONE_BYTES + field;
  const hc = readTrackHeader(child.boneBuf, at(child));
  const hp = readTrackHeader(parent.boneBuf, at(parent));
  if (hc.gseq < 0 && hp.gseq < 0) return seq.level;
  if (hc.gseq >= 0 && (hp.gseq >= 0 || !trackHasKeys(parent.boneBuf, hp))) return child;
  if (hp.gseq >= 0 && !trackHasKeys(child.boneBuf, hc)) return parent;
  throw new Error(`bone ${bone}: track is global in one skeleton and per sequence in the other`);
}

function bindTrack(model: M2Model, seq: Sequence, buffers: ClipBuffers, bone: number, field: number, kind: ValueKind, stats: KeyStats): BoundTrack {
  const level = pickLevel(model, seq, bone, field);
  const rec = level.boneBuf;
  const h = readTrackHeader(rec, level.boneOff + bone * BONE_BYTES + field);
  if (h.gseq >= 0) {
    return { keys: readKeys(rec, h, 0, rec, kind, stats), loop: model.gloops[h.gseq] ?? 0, gseq: h.gseq };
  }
  if (level !== seq.level) return { keys: null, loop: 0, gseq: -1 };
  return { keys: readKeys(rec, h, seq.concrete, buffers.bones, kind, stats), loop: 0, gseq: -1 };
}

export interface BoneSampler {
  /** The bone's retail-space TRS at t ms. Absent tracks give identity. */
  trs(t: number, trans: Float64Array, rot: Float64Array, scale: Float64Array): void;
  /** Does any track of this bone exist for this clip? False bones hold bind pose throughout. */
  animated: boolean;
  /** Does a track run on a global loop? */
  usesGlobalLoop: boolean;
}

export function boneSampler(model: M2Model, seq: Sequence, buffers: ClipBuffers, bone: number, stats: KeyStats): BoneSampler {
  const t = bindTrack(model, seq, buffers, bone, OFF_TRANS, "vec3", stats);
  const r = bindTrack(model, seq, buffers, bone, OFF_ROT, "quat16", stats);
  const s = bindTrack(model, seq, buffers, bone, OFF_SCALE, "vec3", stats);
  return {
    animated: !!(t.keys || r.keys || s.keys),
    usesGlobalLoop: (!!t.keys && t.gseq >= 0) || (!!r.keys && r.gseq >= 0) || (!!s.keys && s.gseq >= 0),
    trs(time, trans, rot, scale) {
      if (!evalInto(t, time, false, trans)) trans.fill(0);
      if (evalInto(r, time, true, rot)) {
        const len = Math.hypot(rot[0]!, rot[1]!, rot[2]!, rot[3]!);
        if (len > 1e-9) for (let c = 0; c < 4; c++) rot[c] = rot[c]! / len;
        else rot.set([0, 0, 0, 1]);
      } else {
        rot.set([0, 0, 0, 1]);
      }
      if (!evalInto(s, time, false, scale)) scale.fill(1);
    },
  };
}

/** q * v * conj(q). */
export function rotateVec(q: ArrayLike<number>, v: ArrayLike<number>, out: Float64Array): void {
  const x = q[0]!;
  const y = q[1]!;
  const z = q[2]!;
  const w = q[3]!;
  const vx = v[0]!;
  const vy = v[1]!;
  const vz = v[2]!;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
}

export interface SampledTrack {
  bone: number;
  path: "translation" | "rotation" | "scale";
  /** Target (Y-up) space. One key when constant, `frames` keys otherwise. */
  values: Float32Array;
  constant: boolean;
}

export interface SampledClip {
  /** Key times in seconds. */
  times: Float32Array;
  tracks: SampledTrack[];
  /** Tracks removed because they equal the rest pose throughout. */
  dropped: number;
  globalLoopBones: number;
}

const EPS_T = 1e-5;
const EPS_R = 1e-4;
const EPS_S = 1e-5;

/**
 * n intervals of about 1/30 s over the clip's exact duration, so the last key is
 * the loop point and the mixer's duration equals retail's.
 */
export function sampleGrid(durationMs: number, fps = 30): Float64Array {
  const n = Math.max(1, Math.round((durationMs / 1000) * fps));
  const t = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = (i * durationMs) / n;
  return t;
}

/**
 * One clip as glTF TRS over Y-up joints with identity rest transforms. The bone's
 * retail transform is T(pivot) T(trans) R S T(-pivot), and the contract's formula
 * T' = pivot + trans - R(S * pivot) is that matrix in TRS form.
 *
 * A track equal to the rest pose throughout is dropped. That also covers bones no
 * vertex uses: on Human male, cutting them on top of this saves nothing (0 bytes
 * across three clips), so bones stay available to items skinned by name.
 */
export function sampleClip(model: M2Model, seq: Sequence, buffers: ClipBuffers, grid: Float64Array, stats: KeyStats): SampledClip {
  const frames = grid.length;
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i++) times[i] = grid[i]! / 1000;
  const tracks: SampledTrack[] = [];
  let dropped = 0;
  let globalLoopBones = 0;
  const tr = new Float64Array(3);
  const rt = new Float64Array(4);
  const sc = new Float64Array(3);
  const rs = new Float64Array(3);
  const sp = new Float64Array(3);

  for (let b = 0; b < model.bones.length; b++) {
    const sampler = boneSampler(model, seq, buffers, b, stats);
    if (!sampler.animated) continue;
    if (sampler.usesGlobalLoop) globalLoopBones++;
    const piv = model.bones[b]!.pivot;
    const T = new Float32Array(frames * 3);
    const R = new Float32Array(frames * 4);
    const S = new Float32Array(frames * 3);
    let prev: [number, number, number, number] | null = null;
    for (let f = 0; f < frames; f++) {
      sampler.trs(grid[f]!, tr, rt, sc);
      sp[0] = sc[0]! * piv[0];
      sp[1] = sc[1]! * piv[1];
      sp[2] = sc[2]! * piv[2];
      rotateVec(rt, sp, rs);
      const tx = piv[0] + tr[0]! - rs[0]!;
      const ty = piv[1] + tr[1]! - rs[1]!;
      const tz = piv[2] + tr[2]! - rs[2]!;
      // Retail (x, y, z) -> target (y, z, x), quaternions likewise (contract).
      T[f * 3] = ty;
      T[f * 3 + 1] = tz;
      T[f * 3 + 2] = tx;
      let qx = rt[1]!;
      let qy = rt[2]!;
      let qz = rt[0]!;
      let qw = rt[3]!;
      // Keep the sign continuous along the track: smaller deltas compress better.
      if (prev && qx * prev[0] + qy * prev[1] + qz * prev[2] + qw * prev[3] < 0) {
        qx = -qx;
        qy = -qy;
        qz = -qz;
        qw = -qw;
      }
      prev = [qx, qy, qz, qw];
      R[f * 4] = qx;
      R[f * 4 + 1] = qy;
      R[f * 4 + 2] = qz;
      R[f * 4 + 3] = qw;
      S[f * 3] = sc[1]!;
      S[f * 3 + 1] = sc[2]!;
      S[f * 3 + 2] = sc[0]!;
    }
    const addTrack = (path: SampledTrack["path"], values: Float32Array, stride: number, rest: number[], eps: number) => {
      let isRest = true;
      let isConstant = true;
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < stride; c++) {
          const v = values[f * stride + c]!;
          let d = Math.abs(v - rest[c]!);
          // A quaternion and its negative are the same rotation.
          if (path === "rotation") d = Math.min(d, Math.abs(v + rest[c]!));
          if (d > eps) isRest = false;
          if (Math.abs(v - values[c]!) > eps) isConstant = false;
        }
        if (!isRest && !isConstant) break;
      }
      if (isRest) {
        dropped++;
        return;
      }
      tracks.push({ bone: b, path, values: isConstant ? values.slice(0, stride) : values, constant: isConstant });
    };
    addTrack("translation", T, 3, [0, 0, 0], EPS_T);
    addTrack("rotation", R, 4, [0, 0, 0, 1], EPS_R);
    addTrack("scale", S, 3, [1, 1, 1], EPS_S);
  }
  return { times, tracks, dropped, globalLoopBones };
}
