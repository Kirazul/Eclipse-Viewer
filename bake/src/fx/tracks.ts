import type { FxLifeCurve, FxTrack, FxValue } from "@eclipse/format";
import type { M2Model, Sequence } from "../m2/model";
import { type TrackHeader, readTrackHeader } from "../m2/sample";

/**
 * An emitter's tracks as compact JSON. Nearly all of them hold one key across every
 * sequence, so those become a plain number, which is what keeps a mount's fx small.
 * Kinds the model's own tracks never use are here too: u8, u16 and retail's packed
 * gravity (Eclipse's tools/lib/m2_port.py, gravity_vector).
 */

export type EmitterKind = "f32" | "vec3" | "fixed16" | "u8" | "u16" | "gravity";

const ELEM: Record<EmitterKind, number> = { f32: 4, vec3: 12, fixed16: 2, u8: 1, u16: 2, gravity: 4 };

/** Retail's packed gravity unit, the float 0x3D2D9C72 (client 0x1011088f0). */
const GRAVITY_UNIT = Buffer.from([0x72, 0x9c, 0x2d, 0x3d]).readFloatLE(0);

export function round(v: number, digits = 4): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** Retail's vector for one packed key: (|m| dx, |m| dy, sign(m) |m| sqrt(1 - dx^2 - dy^2)). */
export function packedGravity(buf: Buffer, at: number): [number, number, number] {
  const dx = buf.readInt8(at) / 128;
  const dy = buf.readInt8(at + 1) / 128;
  const m = buf.readInt16LE(at + 2) * GRAVITY_UNIT;
  const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
  const a = Math.abs(m);
  return [a * dx, a * dy, (m >= 0 ? dz : -dz) * a];
}

function readValue(buf: Buffer, at: number, kind: EmitterKind, packed: boolean): number | number[] {
  switch (kind) {
    case "f32":
      return round(buf.readFloatLE(at), 5);
    case "vec3":
      return [round(buf.readFloatLE(at), 5), round(buf.readFloatLE(at + 4), 5), round(buf.readFloatLE(at + 8), 5)];
    case "fixed16":
      return round(buf.readInt16LE(at) / 32767, 5);
    case "u8":
      return buf[at]!;
    case "u16":
      return buf.readUInt16LE(at);
    case "gravity": {
      if (!packed) return round(buf.readFloatLE(at), 5);
      const v = packedGravity(buf, at).map((c) => round(c, 5));
      // No sideways part: the plain number, which is (0, 0, -g).
      return v[0] === 0 && v[1] === 0 ? round(-v[2]!, 5) : v;
    }
  }
}

type KeyList = [number[], (number | number[])[]];

function readList(rec: Buffer, h: TrackHeader, s: number, keyBuf: Buffer, kind: EmitterKind, packed: boolean): KeyList | null {
  if (s >= h.timesCount || s >= h.valuesCount) return null;
  const n = rec.readUInt32LE(h.timesAt + s * 8);
  const tOff = rec.readUInt32LE(h.timesAt + s * 8 + 4);
  const vn = rec.readUInt32LE(h.valuesAt + s * 8);
  const vOff = rec.readUInt32LE(h.valuesAt + s * 8 + 4);
  if (n === 0 || n !== vn) return null;
  const elem = ELEM[kind];
  if (tOff + n * 4 > keyBuf.length || vOff + n * elem > keyBuf.length) return null;
  const times: number[] = [];
  const values: (number | number[])[] = [];
  for (let i = 0; i < n; i++) {
    times.push(keyBuf.readUInt32LE(tOff + i * 4));
    values.push(readValue(keyBuf, vOff + i * elem, kind, packed));
  }
  return [times, values];
}

/** Reads a model's emitter tracks, keeping each sequence's `.anim` block once. */
export class EmitterTracks {
  private readonly blocks = new Map<Sequence, Buffer>();

  constructor(
    readonly model: M2Model,
    private readonly clips: Sequence[],
    private readonly loadModelBlock: (seq: Sequence) => Promise<Buffer>,
  ) {}

  private async block(seq: Sequence): Promise<Buffer> {
    const hit = this.blocks.get(seq);
    if (hit) return hit;
    const b = await this.loadModelBlock(seq);
    this.blocks.set(seq, b);
    return b;
  }

  /** Undefined: the track has no keys anywhere, so the field keeps its default. */
  async value(at: number, kind: EmitterKind, packed = false): Promise<FxValue | undefined> {
    const md = this.model.md;
    const h = readTrackHeader(md, at);
    const hold = h.interp === 0;
    if (h.gseq >= 0) {
      const list = readList(md, h, 0, md, kind, packed);
      if (!list) return undefined;
      if (list[0].length === 1) return list[1][0]!;
      return { globalLoop: h.gseq, clips: { "*": list }, ...(hold ? { hold } : {}) };
    }
    const perClip = new Map<string, KeyList>();
    let first: KeyList | null = null;
    for (const seq of this.clips) {
      // A model's own tracks are indexed by its own skeleton's sequences. An inherited
      // parent sequence has none of them.
      if (seq.level.name === "parent") continue;
      const s = seq.concrete;
      if (s >= h.timesCount || md.readUInt32LE(h.timesAt + s * 8) === 0) continue;
      const list = readList(md, h, s, await this.block(seq), kind, packed);
      if (!list) continue;
      perClip.set(`${seq.id}.${seq.variation}`, list);
      first ??= list;
    }
    if (!first) return undefined;
    // The most common list is "any clip". Usually that is all of them, with one key.
    const counts = new Map<string, { n: number; list: KeyList }>();
    for (const list of perClip.values()) {
      const json = JSON.stringify(list);
      const c = counts.get(json);
      if (c) c.n++;
      else counts.set(json, { n: 1, list });
    }
    let top = { n: 0, list: first };
    for (const c of counts.values()) if (c.n > top.n) top = c;
    const topJson = JSON.stringify(top.list);
    const constant = counts.size === 1 && top.list[0].length === 1;
    if (constant) return top.list[1][0]!;
    const clips: FxTrack["clips"] = { "*": top.list };
    for (const [id, list] of perClip) if (JSON.stringify(list) !== topJson) clips[id] = list;
    return { clips, ...(hold ? { hold } : {}) };
  }
}

/** Times are fixed16 over the particle's life, values follow `read`. Null: no keys. */
export function lifeCurve(md: Buffer, at: number, stride: number, read: (o: number) => number | number[]): FxLifeCurve | null {
  const nt = md.readUInt32LE(at);
  const ot = md.readUInt32LE(at + 4);
  const nv = md.readUInt32LE(at + 8);
  const ov = md.readUInt32LE(at + 12);
  if (nv === 0) return null;
  const t: number[] = [];
  for (let i = 0; i < nt; i++) t.push(round(md.readInt16LE(ot + i * 2) / 32767));
  const v: (number | number[])[] = [];
  for (let i = 0; i < nv; i++) v.push(read(ov + i * stride));
  return { t, v };
}
