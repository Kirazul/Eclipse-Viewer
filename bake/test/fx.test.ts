/**
 * Emitters and ribbons, read from the bytes. A synthetic record pins each field's place
 * and meaning; real mounts, when their raw files are in work/raw, are compared with the
 * tables Eclipse ships (gen_fx.py), which come from its own pipeline.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FxParticle, FxRibbon, FxTrack } from "@eclipse/format";
import { BUILD } from "@eclipse/format";
import { emitterWarnings, particleColorsOf, readParticles, readRibbons } from "../src/fx/emitters";
import { EmitterTracks, packedGravity } from "../src/fx/tracks";
import { REPO } from "../src/lib/env";
import { parseDeps } from "../src/m2/chunks";
import { M2Model, type Sequence } from "../src/m2/model";

/** Bytes of a model's header and one emitter or ribbon record, with data appended behind. */
class Builder {
  buf = Buffer.alloc(0x4000);
  end = 0x2000;

  /** Puts a block at the end, returns its offset. */
  block(b: Buffer): number {
    const at = this.end;
    b.copy(this.buf, at);
    this.end += b.length + (4 - (b.length % 4)) % 4;
    return at;
  }

  f32(...v: number[]): Buffer {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => b.writeFloatLE(x, i * 4));
    return b;
  }

  /** An M2Track with one per-sequence key list per entry of `perSeq`. */
  track(at: number, interp: number, gseq: number, perSeq: { t: number[]; v: Buffer; elem: number }[]): void {
    const times = Buffer.alloc(perSeq.length * 8);
    const values = Buffer.alloc(perSeq.length * 8);
    perSeq.forEach((s, i) => {
      const tb = Buffer.alloc(s.t.length * 4);
      s.t.forEach((t, k) => tb.writeUInt32LE(t, k * 4));
      times.writeUInt32LE(s.t.length, i * 8);
      times.writeUInt32LE(this.block(tb), i * 8 + 4);
      values.writeUInt32LE(s.t.length, i * 8);
      values.writeUInt32LE(this.block(s.v), i * 8 + 4);
    });
    this.buf.writeUInt16LE(interp, at);
    this.buf.writeInt16LE(gseq, at + 2);
    this.buf.writeUInt32LE(perSeq.length, at + 4);
    this.buf.writeUInt32LE(this.block(times), at + 8);
    this.buf.writeUInt32LE(perSeq.length, at + 12);
    this.buf.writeUInt32LE(this.block(values), at + 16);
  }

  /** An M2PartTrack. */
  part(at: number, times: number[], values: Buffer): void {
    const tb = Buffer.alloc(times.length * 2);
    times.forEach((t, k) => tb.writeInt16LE(t, k * 2));
    this.buf.writeUInt32LE(times.length, at);
    this.buf.writeUInt32LE(this.block(tb), at + 4);
    const count = times.length;
    this.buf.writeUInt32LE(count, at + 8);
    this.buf.writeUInt32LE(this.block(values), at + 12);
  }
}

function seq(id: number, concrete: number): Sequence {
  return { index: concrete, id, variation: 0, durationMs: 1000, flags: 0x20, frequency: 0, alias: false, level: { name: "model" } as never, concrete };
}

function fakeModel(md: Buffer, extra: Partial<M2Model> = {}): M2Model {
  return { md, chunks: new Map(), textures: [{ type: 0, flags: 3, fileDataId: 1 }, { type: 0, flags: 0, fileDataId: 2 }, { type: 0, flags: 1, fileDataId: 3 }], materials: [{ flags: 1, blend: 4 }], flags: 0, transformLookup: [], gloops: [], ...extra } as unknown as M2Model;
}

function particleRecord(b: Builder): number {
  const at = 0x400;
  b.buf.writeUInt32LE(1, 0x128);
  b.buf.writeUInt32LE(at, 0x12c);
  b.buf.writeUInt32LE(0x20000 | 0x800000 | 0x10000000, at + 4);
  b.buf.writeFloatLE(1, at + 8);
  b.buf.writeFloatLE(2, at + 12);
  b.buf.writeFloatLE(3, at + 16);
  b.buf.writeUInt16LE(7, at + 0x14);
  b.buf.writeUInt16LE(1 | (2 << 5) | (0 << 10), at + 0x16);
  b.buf[at + 0x28] = 7;
  b.buf[at + 0x29] = 2;
  b.buf[at + 0x2c] = (1 << 5) | 16; // 1.5 in 3.5 fixed
  b.buf[at + 0x2d] = 2 << 5;
  b.buf.writeUInt16LE(2, at + 0x30);
  b.buf.writeUInt16LE(4, at + 0x32);
  return at;
}

describe("reading an emitter", () => {
  it("every field lands where the client reads it", async () => {
    const b = new Builder();
    const at = particleRecord(b);
    const same = { t: [0], v: b.f32(4.5), elem: 4 };
    b.track(at + 0x34, 1, -1, [same, same]);
    // Packed gravity: x 0, y 0, z 100 -> straight up, so the plain number -(100 * unit).
    const pg = Buffer.alloc(4);
    pg.writeInt16LE(100, 2);
    b.track(at + 0x84, 1, -1, [{ t: [0], v: pg, elem: 4 }]);
    b.track(at + 0xb0, 1, -1, [{ t: [0, 500], v: b.f32(10, 20), elem: 4 }, { t: [0], v: b.f32(30), elem: 4 }]);
    b.buf.writeFloatLE(0.25, at + 0xac);
    b.buf.writeFloatLE(5, at + 0xc4);
    const col = b.f32(255, 0, 0, 0, 255, 0, 0, 0, 255);
    b.part(at + 0x104, [0, 16384, 32767], col);
    const alpha = Buffer.alloc(6);
    alpha.writeInt16LE(32767, 0);
    alpha.writeInt16LE(16384, 2);
    alpha.writeInt16LE(0, 4);
    b.part(at + 0x114, [0, 16384, 32767], alpha);
    b.part(at + 0x124, [0, 32767], b.f32(1, 2, 3, 4));
    const cell = Buffer.alloc(4);
    cell.writeUInt16LE(0, 0);
    cell.writeUInt16LE(7, 2);
    b.part(at + 0x13c, [0, 32767], cell);
    b.buf.writeFloatLE(0.1, at + 0x134);
    b.buf.writeFloatLE(0.2, at + 0x138);
    b.buf.writeFloatLE(1.5, at + 0x15c);
    b.buf.writeFloatLE(30, at + 0x160);
    b.buf.writeFloatLE(0.5, at + 0x164);
    b.buf.writeFloatLE(0.9, at + 0x168);
    b.buf.writeFloatLE(1.1, at + 0x16c);
    b.buf.writeFloatLE(2, at + 0x170);
    b.buf.writeFloatLE(0.75, at + 0x174);
    b.buf.writeFloatLE(0.1, at + 0x178);
    b.buf.writeFloatLE(0.2, at + 0x17c);
    b.buf.writeFloatLE(0.3, at + 0x180);
    b.buf.writeFloatLE(0.4, at + 0x184);
    b.buf.writeFloatLE(1, at + 0x1a0);
    b.buf.writeFloatLE(2, at + 0x1a4);
    b.buf.writeFloatLE(3, at + 0x1a8);
    b.buf.writeFloatLE(9, at + 0x1ac);
    b.buf.writeUInt16LE(0x0200 | 256, at + 0x1dc); // sign-magnitude 6.9: 1.5
    b.buf.writeUInt16LE(0x8000 | 0x0200, at + 0x1e8); // -1

    // EXP2: alpha x 0.5, colorMult 3, and a cutoff.
    const exp2 = Buffer.alloc(8 + 28 + 8);
    exp2.writeUInt32LE(1, 0);
    exp2.writeUInt32LE(8, 4);
    exp2.writeFloatLE(0, 8);
    exp2.writeFloatLE(3, 12);
    exp2.writeFloatLE(0.5, 16);
    exp2.writeUInt32LE(2, 20);
    exp2.writeUInt32LE(36, 24);
    exp2.writeUInt32LE(2, 28);
    exp2.writeUInt32LE(40, 32);
    exp2.writeInt16LE(0, 36);
    exp2.writeInt16LE(32767, 38);
    exp2.writeInt16LE(0, 40);
    exp2.writeInt16LE(16384, 42);
    // PGD1: one geoset id.
    const pgd1 = Buffer.alloc(10);
    pgd1.writeUInt32LE(1, 0);
    pgd1.writeUInt32LE(8, 4);
    pgd1.writeUInt16LE(1701, 8);

    const model = fakeModel(b.buf, { chunks: new Map([["EXP2", [exp2]], ["PGD1", [pgd1]]]) as never });
    const clips = [seq(0, 0), seq(4, 1)];
    const [e] = await readParticles(model, new EmitterTracks(model, clips, async () => b.buf));
    const p = e as FxParticle;
    // (x, y, z) -> (y, z, x)
    expect(p.pos).toEqual([2, 3, 1]);
    expect(p.bone).toBe(7);
    expect(p.type).toBe(2);
    expect(p.blend).toBe(7);
    // Three 5-bit indices, wrap from each texture's flags.
    expect(p.tex).toEqual([1, 2, 0]);
    expect(p.wrap).toEqual([0, 1, 3]);
    expect(p.rows).toBe(2);
    expect(p.cols).toBe(4);
    expect(p.geoset).toBe(1701);
    // Constant across clips: a plain number.
    expect(p.speed).toBe(4.5);
    expect(p.gravity).toBeCloseTo(-100 * 0.0423855, 3);
    // Differs per clip: the commoner list is "any clip", the other named.
    const rate = p.rate as FxTrack;
    expect(rate.clips["*"]).toEqual([[0, 500], [10, 20]]);
    expect(rate.clips["4.0"]).toEqual([[0], [30]]);
    expect(p.lifeVar).toBe(0.25);
    expect(p.rateVar).toBe(5);
    expect(p.color.t).toEqual([0, 0.5, 1]);
    expect(p.color.v[1]).toEqual([0, 255, 0]);
    // EXP2 alphaMult is baked into the curve, and colorMult stays for the program.
    expect(p.alpha.v[0]).toBeCloseTo(0.5, 3);
    expect(p.alpha.v[1]).toBeCloseTo(0.25, 3);
    expect(p.multi?.colorMult).toBe(3);
    expect(p.cut?.t).toEqual([0, 1]);
    expect(p.cut?.v[1]).toBeCloseTo(0.5, 3);
    expect(p.head?.v).toEqual([0, 7]);
    expect(p.scale.v[1]).toEqual([3, 4]);
    expect(p.scaleVar).toEqual([0.1, 0.2]);
    expect(p.tailLength).toBe(1.5);
    expect(p.twinkle).toEqual([30, 0.5, 0.9, 1.1]);
    expect(p.inherit).toBe(2);
    expect(p.drag).toBe(0.75);
    // The client reads the rate from +0x184, its variation from +0x180.
    expect(p.spin).toEqual([0.1, 0.2, 0.4, 0.3]);
    expect(p.wind).toEqual([1, 2, 3, 9]);
    expect(p.multi?.scale).toEqual([1.5, 2]);
    expect(p.multi?.p0[0]).toBe(1.5);
    expect(p.multi?.p1[2]).toBe(-1);
  });

  it("packed gravity is retail's vector", () => {
    const b = Buffer.alloc(4);
    b.writeInt8(64, 0);
    b.writeInt8(0, 1);
    b.writeInt16LE(-100, 2);
    const [x, y, z] = packedGravity(b, 0);
    const m = 100 * 0.0423855;
    expect(x).toBeCloseTo(m * 0.5, 3);
    expect(y).toBe(0);
    expect(z).toBeCloseTo(-m * Math.sqrt(1 - 0.25), 3);
  });

  it("a global loop stays a global loop", async () => {
    const b = new Builder();
    const at = particleRecord(b);
    b.track(at + 0x34, 0, 0, [{ t: [0, 100], v: b.f32(1, 2), elem: 4 }]);
    const model = fakeModel(b.buf);
    const [p] = await readParticles(model, new EmitterTracks(model, [seq(0, 0)], async () => b.buf));
    const speed = (p as FxParticle).speed as FxTrack;
    expect(speed.globalLoop).toBe(0);
    expect(speed.hold).toBe(true);
  });

  it("a model without emitters adds no bytes", async () => {
    const b = new Builder();
    const model = fakeModel(b.buf);
    const tracks = new EmitterTracks(model, [], async () => b.buf);
    expect(await readParticles(model, tracks)).toEqual([]);
    expect(await readRibbons(model, tracks)).toEqual([]);
    expect(emitterWarnings(model)).toEqual([]);
  });
});

describe("a display's ParticleColor", () => {
  it("is read only for the indices the emitters use, as RGB", async () => {
    const b = new Builder();
    const at = particleRecord(b);
    b.buf.writeUInt16LE(12, at + 0x2a);
    const model = fakeModel(b.buf);
    let asked = 0;
    const db = {
      where: async () => {
        asked++;
        return [{ ID: "9", Start_1: String(0xff102030 | 0), MID_1: "65280", End_1: "255" }];
      },
    } as never;
    expect(await particleColorsOf(db, model, 0)).toBeUndefined();
    expect(asked).toBe(0);
    expect(await particleColorsOf(db, model, 9)).toEqual({ 12: [[0x10, 0x20, 0x30], [0, 255, 0], [0, 0, 255]] });
    b.buf.writeUInt16LE(0, at + 0x2a);
    expect(await particleColorsOf(db, model, 9)).toBeUndefined();
  });
});

describe("reading a ribbon", () => {
  it("three textures keep their transforms", async () => {
    const b = new Builder();
    const at = 0x600;
    b.buf.writeUInt32LE(1, 0x120);
    b.buf.writeUInt32LE(at, 0x124);
    b.buf.writeUInt16LE(5, at + 4);
    b.buf.writeFloatLE(1, at + 8);
    const tex = Buffer.alloc(6);
    tex.writeUInt16LE(0, 0);
    tex.writeUInt16LE(1, 2);
    tex.writeUInt16LE(2, 4);
    b.buf.writeUInt32LE(3, at + 0x14);
    b.buf.writeUInt32LE(b.block(tex), at + 0x18);
    const mats = Buffer.alloc(2);
    b.buf.writeUInt32LE(1, at + 0x1c);
    b.buf.writeUInt32LE(b.block(mats), at + 0x20);
    b.buf.writeFloatLE(30, at + 0x74);
    b.buf.writeFloatLE(0.5, at + 0x78);
    b.buf.writeFloatLE(-1, at + 0x7c);
    b.buf.writeUInt16LE(1, at + 0x80);
    b.buf.writeUInt16LE(1, at + 0x82);
    b.track(at + 0x24, 1, -1, [{ t: [0], v: b.f32(0.5, 0.25, 1), elem: 12 }]);
    const al = Buffer.alloc(2);
    al.writeInt16LE(16384, 0);
    b.track(at + 0x38, 1, -1, [{ t: [0], v: al, elem: 2 }]);
    b.track(at + 0x4c, 1, -1, [{ t: [0], v: b.f32(0.3), elem: 4 }]);
    b.track(at + 0x60, 1, -1, [{ t: [0], v: b.f32(0.2), elem: 4 }]);
    // Transforms: lookup[base + k]; one with scale 2,3 and speed 4,5.
    b.buf.writeUInt32LE(1, 0x60);
    const xf = 0x800;
    b.buf.writeUInt32LE(xf, 0x64);
    b.track(xf, 1, -1, [{ t: [0], v: b.f32(4, 5, 0), elem: 12 }]);
    b.track(xf + 40, 1, -1, [{ t: [0], v: b.f32(2, 3, 1), elem: 12 }]);
    b.buf[at + 175] = 1;
    const model = fakeModel(b.buf, { flags: 0x20000, transformLookup: [-1, 0, -1, -1] });
    const [e] = await readRibbons(model, new EmitterTracks(model, [seq(0, 0)], async () => b.buf));
    const r = e as FxRibbon;
    expect(r.bone).toBe(5);
    expect(r.pos).toEqual([0, 0, 1]);
    expect(r.tex).toEqual([0, 1, 2]);
    expect(r.mats).toEqual([{ blend: 4, flags: 1 }]);
    expect(r.edgesPerSec).toBe(30);
    expect(r.lifetime).toBe(0.5);
    expect(r.gravity).toBe(-1);
    expect(r.color).toEqual([0.5, 0.25, 1]);
    expect(r.alpha).toBeCloseTo(0.5, 3);
    expect(r.above).toBe(0.3);
    expect(r.below).toBe(0.2);
    expect(r.layers?.[0]).toEqual({ scale: [2, 3], speed: [4, 5] });
    expect(r.layers?.[1]).toEqual({ scale: [1, 1], speed: [0, 0] });
  });
});

const golden = JSON.parse(readFileSync(new URL("./fixtures/fx-golden.json", import.meta.url), "utf8")) as Record<
  string,
  {
    stem: string;
    particles: { index: number; three: number; mat: number; t1: number; t2: number; scale: number[]; p0: number[]; p1: number[]; colorMult: number; cut: number[][]; fx: number }[];
    ribbons: { index: number; t1: number; t2: number; scale: number[][]; speed: number[][] }[];
  }
>;

const RAW = join(REPO, "work", "raw", BUILD.version);

describe("against the tables Eclipse ships", () => {
  for (const [fdid, want] of Object.entries(golden)) {
    const path = join(RAW, fdid);
    it.skipIf(!existsSync(path))(`${want.stem} (${fdid})`, async () => {
      const raw = readFileSync(path);
      const deps = parseDeps(raw);
      const skel = deps.skel[0] && existsSync(join(RAW, String(deps.skel[0]))) ? readFileSync(join(RAW, String(deps.skel[0]))) : undefined;
      const model = new M2Model(raw, skel);
      // No clips: tracks are not what Eclipse's tables hold.
      const tracks = new EmitterTracks(model, [], async () => Buffer.alloc(0));
      const particles = await readParticles(model, tracks);
      expect(particles.length).toBe(want.particles.length);
      for (const row of want.particles) {
        const p = particles[row.index]!;
        expect(!!p.multi, `emitter ${row.index} three textures`).toBe(row.three === 1);
        if (p.multi) {
          expect(p.tex[1]).toBe(row.t1);
          expect(p.tex[2]).toBe(row.t2);
          expect(p.multi.mat).toBe(row.mat);
          expect(p.multi.scale[0]).toBeCloseTo(row.scale[0]!, 4);
          expect(p.multi.scale[1]).toBeCloseTo(row.scale[1]!, 4);
          for (let k = 0; k < 4; k++) {
            expect(p.multi.p0[k]).toBeCloseTo(row.p0[k]!, 3);
            expect(p.multi.p1[k]).toBeCloseTo(row.p1[k]!, 3);
          }
          expect(p.multi.colorMult).toBeCloseTo(row.colorMult, 3);
        }
        if (row.cut.length) {
          expect(p.cut?.v.length).toBe(row.cut.length);
          row.cut.forEach(([t, v], i) => {
            expect(p.cut!.t[i]).toBeCloseTo(t! / 32767, 3);
            expect(p.cut!.v[i]).toBeCloseTo(v! / 32767, 3);
          });
        } else {
          expect(p.cut).toBeUndefined();
        }
        // fx 1 BlendAdd, 2 alpha key.
        if (row.fx & 1) expect(p.blend).toBe(7);
        if (row.fx & 2) expect(p.blend).toBe(1);
      }
      const ribbons = await readRibbons(model, tracks);
      for (const row of want.ribbons) {
        const r = ribbons[row.index]!;
        expect(r.tex.length).toBeGreaterThanOrEqual(3);
        expect(r.tex[1]).toBe(row.t1);
        expect(r.tex[2]).toBe(row.t2);
        for (let k = 0; k < 3; k++) {
          const l = r.layers?.[k] ?? { scale: [1, 1], speed: [0, 0] };
          expect(l.scale[0]).toBeCloseTo(row.scale[k]![0]!, 4);
          expect(l.scale[1]).toBeCloseTo(row.scale[k]![1]!, 4);
          expect(l.speed[0]).toBeCloseTo(row.speed[k]![0]!, 4);
          expect(l.speed[1]).toBeCloseTo(row.speed[k]![1]!, 4);
        }
      }
    });
  }
});
