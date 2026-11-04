import type { FxLifeCurve, FxParticle, FxRibbon, ModelManifest, Vec3 } from "@eclipse/format";
import { num, type Db2 } from "../db2/db2";
import { chunk } from "../m2/chunks";
import type { M2Model } from "../m2/model";
import { EmitterTracks, lifeCurve, round } from "./tracks";

/**
 * Retail's emitters and ribbons as FxData. The record layouts are Eclipse's
 * tools/lib/m2_layout.py and m2model.py (3.3.5's 476-byte record plus sixteen bytes at
 * the tail), the meaning of each field the client's CM2Model::InitializeLoaded, and
 * retail's extras (EXP2, PGD1, the three-texture layers, packed gravity) Eclipse's
 * tools/retailmounts/mount_convert.py, particle_records and ribbon_layers.
 */

const SZ_PARTICLE = 492;
const SZ_RIBBON = 176;
const EXP2_RECORD = 28;
const PF_PACKED_GRAVITY = 0x800000;
const PF_MULTI_TEXTURE = 0x10000000;
/** Retail's new-style particle programs: a uv-mapped three-texture path not ported yet. */
const PF_3TEX_UV = 0x100000;
const GF_RIBBON_TRANSFORMS = 0x20000;
const H_PARTICLES = 0x128;
const H_RIBBONS = 0x120;

const toY = (x: number, y: number, z: number): Vec3 => [round(y, 5), round(z, 5), round(x, 5)];

function fixed35(b: number): number {
  return (b >> 5) + (b & 31) / 32;
}

function fixed69(v: number): number {
  const mag = ((v >> 9) & 63) + (v & 511) / 512;
  return v & 0x8000 ? -mag : mag;
}

interface Exp2 {
  zsource: number;
  colorMult: number;
  alphaMult: number;
  cut: FxLifeCurve | null;
}

function readExp2(model: M2Model): Exp2[] {
  const b = chunk(model.chunks, "EXP2");
  if (!b || b.length < 8) return [];
  const count = b.readUInt32LE(0);
  const off = b.readUInt32LE(4);
  const out: Exp2[] = [];
  for (let i = 0; i < count; i++) {
    const at = off + i * EXP2_RECORD;
    const curve = lifeCurve(b, at + 12, 2, (o) => round(b.readInt16LE(o) / 32767));
    // An all-zero track cuts nothing: step(0, a) = 1.
    const cut = curve && curve.v.some((v) => v !== 0) ? curve : null;
    out.push({ zsource: b.readFloatLE(at), colorMult: b.readFloatLE(at + 4), alphaMult: b.readFloatLE(at + 8), cut });
  }
  return out;
}

function geosetIds(model: M2Model): number[] {
  const b = chunk(model.chunks, "PGD1");
  if (!b || b.length < 8) return [];
  const n = b.readUInt32LE(0);
  const o = b.readUInt32LE(4);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(b.readUInt16LE(o + i * 2));
  return out;
}

/** Leaves out absent and default fields: every one of them is bytes on the owner's line. */
function set<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined, fallback?: unknown): void {
  if (v === undefined) return;
  if (fallback !== undefined && v === fallback) return;
  o[k] = v;
}

export async function readParticles(model: M2Model, tracks: EmitterTracks): Promise<FxParticle[]> {
  const md = model.md;
  const n = md.readUInt32LE(H_PARTICLES);
  if (n === 0) return [];
  const o = md.readUInt32LE(H_PARTICLES + 4);
  const exp2 = readExp2(model);
  const geosets = geosetIds(model);
  const out: FxParticle[] = [];
  for (let i = 0; i < n; i++) {
    const at = o + i * SZ_PARTICLE;
    const flags = md.readUInt32LE(at + 4);
    const texField = md.readUInt16LE(at + 0x16);
    const multi = (flags & PF_MULTI_TEXTURE) !== 0;
    const tex = multi ? [texField & 31, (texField >> 5) & 31, (texField >> 10) & 31] : [texField];
    const x = exp2[i];
    const alphaMult = x?.alphaMult ?? 1;
    const alpha = lifeCurve(md, at + 0x114, 2, (p) => round(Math.max(0, Math.min(32767, md.readInt16LE(p) * alphaMult)) / 32767));
    const color = lifeCurve(md, at + 0x104, 12, (p) => [round(md.readFloatLE(p), 2), round(md.readFloatLE(p + 4), 2), round(md.readFloatLE(p + 8), 2)]);
    const scale = lifeCurve(md, at + 0x124, 8, (p) => [round(md.readFloatLE(p)), round(md.readFloatLE(p + 4))]);
    const cell = (p: number) => md.readUInt16LE(p);
    const e: FxParticle = {
      flags,
      bone: md.readUInt16LE(at + 0x14),
      pos: toY(md.readFloatLE(at + 8), md.readFloatLE(at + 12), md.readFloatLE(at + 16)),
      type: md[at + 0x29]!,
      blend: md[at + 0x28]!,
      tex,
      wrap: tex.map((t) => (model.textures[t]?.flags ?? 0) & 3),
      color: color ?? { t: [], v: [[255, 255, 255]] },
      alpha: alpha ?? { t: [], v: [1] },
      scale: scale ?? { t: [], v: [[1, 1]] },
    };
    set(e, "rows", md.readUInt16LE(at + 0x30), 1);
    set(e, "cols", md.readUInt16LE(at + 0x32), 1);
    set(e, "geoset", geosets[i], 0);
    set(e, "colorIndex", md.readUInt16LE(at + 0x2a), 0);
    set(e, "priority", md.readInt16LE(at + 0x2e), 0);
    set<FxParticle, "speed">(e, "speed", await tracks.value(at + 0x34, "f32"));
    set<FxParticle, "speedVar">(e, "speedVar", await tracks.value(at + 0x48, "f32"));
    set<FxParticle, "lat">(e, "lat", await tracks.value(at + 0x5c, "f32"));
    set<FxParticle, "lon">(e, "lon", await tracks.value(at + 0x70, "f32"));
    set<FxParticle, "gravity">(e, "gravity", await tracks.value(at + 0x84, "gravity", (flags & PF_PACKED_GRAVITY) !== 0));
    set<FxParticle, "life">(e, "life", await tracks.value(at + 0x98, "f32"));
    set(e, "lifeVar", round(md.readFloatLE(at + 0xac), 5), 0);
    set<FxParticle, "rate">(e, "rate", await tracks.value(at + 0xb0, "f32"));
    set(e, "rateVar", round(md.readFloatLE(at + 0xc4), 5), 0);
    set<FxParticle, "width">(e, "width", await tracks.value(at + 0xc8, "f32"));
    set<FxParticle, "length">(e, "length", await tracks.value(at + 0xdc, "f32"));
    set<FxParticle, "zsource">(e, "zsource", await tracks.value(at + 0xf0, "f32"));
    set<FxParticle, "visible">(e, "visible", await tracks.value(at + 0x1c8, "u8"), 1);
    const head = lifeCurve(md, at + 0x13c, 2, cell);
    const tail = lifeCurve(md, at + 0x14c, 2, cell);
    if (head) e.head = head;
    if (tail) e.tail = tail;
    if (x?.cut) e.cut = x.cut;
    const sx = round(md.readFloatLE(at + 0x134));
    const sy = round(md.readFloatLE(at + 0x138));
    if (sx || sy) e.scaleVar = [sx, sy];
    set(e, "tailLength", round(md.readFloatLE(at + 0x15c)), 0);
    const tw: [number, number, number, number] = [round(md.readFloatLE(at + 0x160)), round(md.readFloatLE(at + 0x164)), round(md.readFloatLE(at + 0x168)), round(md.readFloatLE(at + 0x16c))];
    if (tw[1] !== 1 || tw[2] !== tw[3] || tw[2] !== 1) e.twinkle = tw;
    set(e, "inherit", round(md.readFloatLE(at + 0x170)), 1);
    set(e, "drag", round(md.readFloatLE(at + 0x174)), 0);
    // CM2Model::InitializeLoaded reads the rate from +0x184 and its variation from +0x180.
    const spin: [number, number, number, number] = [round(md.readFloatLE(at + 0x178)), round(md.readFloatLE(at + 0x17c)), round(md.readFloatLE(at + 0x184)), round(md.readFloatLE(at + 0x180))];
    if (spin.some((v) => v !== 0)) e.spin = spin;
    const wind: [number, number, number, number] = [round(md.readFloatLE(at + 0x1a0)), round(md.readFloatLE(at + 0x1a4)), round(md.readFloatLE(at + 0x1a8)), round(md.readFloatLE(at + 0x1ac))];
    if ((wind[0] || wind[1] || wind[2]) && wind[3] > 0) e.wind = wind;
    const follow: [number, number, number, number] = [round(md.readFloatLE(at + 0x1b0)), round(md.readFloatLE(at + 0x1b4)), round(md.readFloatLE(at + 0x1b8)), round(md.readFloatLE(at + 0x1bc))];
    if (follow.some((v) => v !== 0)) e.follow = follow;
    const ns = md.readUInt32LE(at + 0x1c0);
    if (ns) {
      const os = md.readUInt32LE(at + 0x1c4);
      const spline: number[] = [];
      for (let k = 0; k < ns * 3; k++) spline.push(round(md.readFloatLE(os + k * 4), 5));
      e.spline = spline;
    }
    if (multi) {
      const six = (p: number) => round(fixed69(md.readUInt16LE(at + p)), 5);
      e.multi = {
        mat: ((flags >> 30) & 1) | (((flags >> 29) & 1) << 1),
        scale: [fixed35(md[at + 0x2c]!), fixed35(md[at + 0x2d]!)],
        // layer 1 xy, layer 2 xy
        p0: [six(0x1dc), six(0x1de), six(0x1e0), six(0x1e2)],
        p1: [six(0x1e4), six(0x1e6), six(0x1e8), six(0x1ea)],
        colorMult: round(x?.colorMult ?? 1, 5),
      };
    }
    out.push(e);
  }
  return out;
}

/** A constant M2Track<vec3>: its one key, or the default. */
function firstVec3(md: Buffer, at: number, fallback: [number, number]): [number, number] {
  const nv = md.readUInt32LE(at + 12);
  const ov = md.readUInt32LE(at + 16);
  for (let s = 0; s < nv; s++) {
    const n = md.readUInt32LE(ov + s * 8);
    const o = md.readUInt32LE(ov + s * 8 + 4);
    if (n) return [round(md.readFloatLE(o), 5), round(md.readFloatLE(o + 4), 5)];
  }
  return fallback;
}

export async function readRibbons(model: M2Model, tracks: EmitterTracks): Promise<FxRibbon[]> {
  const md = model.md;
  const n = md.readUInt32LE(H_RIBBONS);
  if (n === 0) return [];
  const o = md.readUInt32LE(H_RIBBONS + 4);
  const out: FxRibbon[] = [];
  for (let i = 0; i < n; i++) {
    const at = o + i * SZ_RIBBON;
    const tex: number[] = [];
    const nt = md.readUInt32LE(at + 0x14);
    const ot = md.readUInt32LE(at + 0x18);
    for (let k = 0; k < nt; k++) tex.push(md.readUInt16LE(ot + k * 2));
    const nm = md.readUInt32LE(at + 0x1c);
    const om = md.readUInt32LE(at + 0x20);
    const mats: FxRibbon["mats"] = [];
    for (let k = 0; k < nm; k++) {
      const m = model.materials[md.readUInt16LE(om + k * 2)];
      mats.push({ blend: m?.blend ?? 0, flags: m?.flags ?? 0 });
    }
    const e: FxRibbon = {
      bone: md.readUInt16LE(at + 4),
      pos: toY(md.readFloatLE(at + 8), md.readFloatLE(at + 12), md.readFloatLE(at + 16)),
      tex,
      wrap: tex.map((t) => (model.textures[t]?.flags ?? 0) & 3),
      mats,
      edgesPerSec: round(md.readFloatLE(at + 0x74)),
      lifetime: round(md.readFloatLE(at + 0x78)),
    };
    set<FxRibbon, "color">(e, "color", await tracks.value(at + 0x24, "vec3"));
    set<FxRibbon, "alpha">(e, "alpha", await tracks.value(at + 0x38, "fixed16"), 1);
    set<FxRibbon, "above">(e, "above", await tracks.value(at + 0x4c, "f32"));
    set<FxRibbon, "below">(e, "below", await tracks.value(at + 0x60, "f32"));
    set(e, "gravity", round(md.readFloatLE(at + 0x7c)), 0);
    set(e, "rows", md.readUInt16LE(at + 0x80), 1);
    set(e, "cols", md.readUInt16LE(at + 0x82), 1);
    set<FxRibbon, "slot">(e, "slot", await tracks.value(at + 0x84, "u16"), 0);
    set<FxRibbon, "visible">(e, "visible", await tracks.value(at + 0x98, "u8"), 1);
    set(e, "priority", md.readInt16LE(at + 0xac), 0);
    if (tex.length >= 3) {
      // Each layer's texture transform, when the header says they apply.
      const transforms = md.readUInt32LE(0x60);
      const transformsAt = md.readUInt32LE(0x64);
      const base = md[at + 175]!;
      const layers: NonNullable<FxRibbon["layers"]> = [];
      for (let k = 0; k < 3; k++) {
        const tt = model.flags & GF_RIBBON_TRANSFORMS ? (model.transformLookup[base + k] ?? -1) : -1;
        if (tt >= 0 && tt < transforms) {
          const rec = transformsAt + tt * 0x3c;
          layers.push({ scale: firstVec3(md, rec + 40, [1, 1]), speed: firstVec3(md, rec, [0, 0]) });
        } else {
          layers.push({ scale: [1, 1], speed: [0, 0] });
        }
      }
      if (layers.some((l) => l.scale[0] !== 1 || l.scale[1] !== 1 || l.speed[0] !== 0 || l.speed[1] !== 0)) e.layers = layers;
    }
    out.push(e);
  }
  return out;
}

/**
 * A display's ParticleColorID, as the manifest carries it: one entry per colorIndex this
 * model's emitters read. Undefined when none does, so nothing is looked up for most models.
 */
export async function particleColorsOf(db: Db2, model: M2Model, id: number): Promise<ModelManifest["particleColors"]> {
  if (!id) return undefined;
  const md = model.md;
  const n = md.readUInt32LE(H_PARTICLES);
  const o = md.readUInt32LE(H_PARTICLES + 4);
  const wanted = new Set<number>();
  for (let i = 0; i < n; i++) {
    const index = md.readUInt16LE(o + i * SZ_PARTICLE + 0x2a);
    if (index >= 11 && index <= 13) wanted.add(index);
  }
  if (wanted.size === 0) return undefined;
  const row = (await db.where("ParticleColor", "ID", id))[0];
  if (!row) return undefined;
  const rgb = (v: string | undefined): Vec3 => {
    const c = num(v) >>> 0;
    return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
  };
  const out: NonNullable<ModelManifest["particleColors"]> = {};
  for (const index of wanted) {
    const k = index - 11;
    out[index] = [rgb(row[`Start_${k}`]), rgb(row[`MID_${k}`]), rgb(row[`End_${k}`])];
  }
  return out;
}

/** What a viewer can't show of this model's emitters, for the manifest's warnings. */
export function emitterWarnings(model: M2Model): string[] {
  const md = model.md;
  const out: string[] = [];
  const n = md.readUInt32LE(H_PARTICLES);
  const o = md.readUInt32LE(H_PARTICLES + 4);
  let txac = 0;
  let uvOnly = 0;
  let models = 0;
  const t = chunk(model.chunks, "TXAC");
  const materials = md.readUInt32LE(0x70);
  for (let i = 0; i < n; i++) {
    const at = o + i * SZ_PARTICLE;
    const flags = md.readUInt32LE(at + 4);
    if (t && t.length >= 2 * (materials + i + 1) && t.readUInt16LE(2 * (materials + i)) !== 0) txac++;
    if (flags & PF_3TEX_UV && !(flags & PF_MULTI_TEXTURE)) uvOnly++;
    if (md.readUInt32LE(at + 0x18) || md.readUInt32LE(at + 0x20)) models++;
  }
  if (txac) out.push(`${txac} emitter(s) use retail's TXAC layer mapping: drawn with plain layer UVs`);
  if (uvOnly) out.push(`${uvOnly} emitter(s) use Particle_Unlit_3Tex_UV: drawn as one texture`);
  if (models) out.push(`${models} emitter(s) spawn geometry or child models: those parts are not drawn`);
  return out;
}
