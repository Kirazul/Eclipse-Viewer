import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { buildBodyGlb, geosetBounds } from "../src/gltf/body";
import { buildClipGlb } from "../src/gltf/clip";
import { animName } from "../src/m2/animNames";
import { parseAnim, parseChunks, parseDeps } from "../src/m2/chunks";
import { M2Model, SEQ_ONE_SHOT, parseSkin } from "../src/m2/model";
import { sampleClip, sampleGrid } from "../src/m2/sample";
import { unitUvSources } from "../src/m2/shaders";
import { apply, ClipReader, readAccessor, readGlb, retailToTarget, worldMatrices } from "./lib/glb";

const fx = JSON.parse(readFileSync(new URL("./fixtures/synthetic.json", import.meta.url), "utf8"));
const m2 = Buffer.from(fx.m2, "base64");
const skinBytes = Buffer.from(fx.skin, "base64");
const chunked = Buffer.from(fx.anim, "base64");
const raw = Buffer.from(fx.animRaw, "base64");

beforeAll(async () => {
  await MeshoptEncoder.ready;
});

describe("chunks", () => {
  it("splits and bounds-checks", () => {
    const c = parseChunks(m2);
    expect([...c.keys()]).toEqual(["MD21", "SFID", "TXID", "AFID"]);
    expect(() => parseChunks(Buffer.concat([Buffer.from("AAAA"), Buffer.from([255, 0, 0, 0])]))).toThrow(/overruns/);
    expect(() => parseChunks(Buffer.concat([Buffer.from("AAAA"), Buffer.alloc(4), Buffer.alloc(3)]))).toThrow(/trailing/);
  });

  it("names dependencies", () => {
    const d = parseDeps(m2);
    expect(d.skin).toEqual([7002]);
    expect(d.anim).toEqual([fx.animFdid]);
    expect(d.texture).toEqual([7003]);
    expect(d.phys).toEqual([]);
  });
});

describe(".anim forms", () => {
  it("tells chunked from raw by the magic, not by whether the chunk parser survives", () => {
    const c = parseAnim(chunked);
    expect(c.form).toBe("chunked");
    expect(c.payload("AFM2").equals(raw)).toBe(true);
    expect(c.payload("AFSB").length).toBe(0);
    const r = parseAnim(raw);
    expect(r.form).toBe("raw");
    expect(r.payload("AFSB").equals(raw)).toBe(true);
    expect(r.payload("AFM2").equals(raw)).toBe(true);
  });
});

describe("M2 records", () => {
  const model = new M2Model(m2);

  it("reads the header arrays", () => {
    expect(model.version).toBe(274);
    expect(model.bones.map((b) => b.parent)).toEqual([-1, 0, 1]);
    expect(model.bones[1]!.pivot).toEqual([0, 0, 1]);
    expect(model.gloops).toEqual([400]);
    expect(model.textures).toEqual([
      { type: 0, flags: 3, fileDataId: 7003 },
      { type: 1, flags: 0, fileDataId: 0 },
    ]);
    expect(model.materials).toEqual([{ flags: 4, blend: 2 }]);
  });

  it("follows aliases and tells inline from external", () => {
    const [a, b, c] = model.sequences;
    expect(a!.alias).toBe(false);
    expect(model.animFileOf(a!)).toBe(0);
    expect(model.animFileOf(b!)).toBe(fx.animFdid);
    expect(c!.alias).toBe(true);
    expect(c!.concrete).toBe(0);
    expect(model.isExternalWithoutFile(b!)).toBe(false);
  });

  it("reads the skin: submeshes, batches, wide index starts", () => {
    const s = parseSkin(skinBytes);
    expect(Array.from(s.lookup)).toEqual([0, 1, 2, 3]);
    expect(s.submeshes.map((x) => [x.id, x.indexStart, x.indexCount])).toEqual([
      [0, 0, 3],
      [401, 3, 3],
    ]);
    expect(s.batches[1]).toMatchObject({ shader: 0x4011, submesh: 1, textureCount: 2, coordCombo: 0xffff, priority: 1 });
  });
});

describe("track evaluation against Eclipse's m2_view.py", () => {
  const model = new M2Model(m2);

  async function worldFromClip(seqIndex: number, t: number, anim: Buffer): Promise<number[][]> {
    const seq = model.sequences[seqIndex]!;
    const buffers = await model.clipBuffers(seq, async () => anim);
    // Sampling this exact time, so nothing here is interpolation error.
    const grid = Float64Array.from([t]);
    const s = sampleClip(model, seq, buffers, grid, { short: 0 });
    const locals = model.bones.map((_b, i) => {
      const get = (path: string, rest: number[]) => {
        const tr = s.tracks.find((x) => x.bone === i && x.path === path);
        return tr ? Array.from(tr.values) : rest;
      };
      return [get("translation", [0, 0, 0]), get("rotation", [0, 0, 0, 1]), get("scale", [1, 1, 1])] as const;
    });
    const { trs } = await import("./lib/glb");
    return worldMatrices(
      model.bones.map((b) => b.parent),
      (b) => trs(locals[b]![0], locals[b]![1], locals[b]![2]),
    );
  }

  for (const form of ["chunked", "raw"] as const) {
    it(`reproduces every bone matrix (external keys ${form})`, async () => {
      let worst = 0;
      for (const pose of fx.poses as { seq: number; t: number; matrices: number[][] }[]) {
        const world = await worldFromClip(pose.seq, pose.t, form === "chunked" ? chunked : raw);
        pose.matrices.forEach((m, b) => {
          const want = retailToTarget(m);
          for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(want[k]! - world[b]![k]!));
        });
      }
      // The floats only: no compression in this path.
      expect(worst).toBeLessThan(2e-4);
    });
  }

  it("drops tracks that stay at rest and keeps a constant as one key", async () => {
    const seq = model.sequences[0]!;
    const buffers = await model.clipBuffers(seq, async () => null);
    const s = sampleClip(model, seq, buffers, sampleGrid(seq.durationMs), { short: 0 });
    expect(s.tracks.some((t) => t.bone === 0 && t.path === "rotation")).toBe(false);
    expect(s.tracks.some((t) => t.bone === 0 && t.path === "scale")).toBe(false);
    expect(s.tracks.find((t) => t.bone === 1 && t.path === "rotation")!.constant).toBe(false);
    expect(s.dropped).toBeGreaterThan(0);
  });

  it("counts an array its .anim is too short for and holds the bone", async () => {
    const seq = model.sequences[1]!;
    const stats = { short: 0 };
    const buffers = await model.clipBuffers(seq, async () => raw.subarray(0, 4));
    const s = sampleClip(model, seq, buffers, sampleGrid(seq.durationMs), stats);
    expect(stats.short).toBeGreaterThan(0);
    expect(s.tracks.filter((t) => t.bone === 0).length).toBe(0);
  });

  it("leaves a missing .anim with no keys", async () => {
    const seq = model.sequences[1]!;
    const buffers = await model.clipBuffers(seq, async () => null);
    expect(buffers.form).toBe("missing");
    expect(buffers.bones.length).toBe(0);
  });
});

describe("clip grid", () => {
  it("covers the exact duration, near 30 fps", () => {
    const g = sampleGrid(2667);
    expect(g[0]).toBe(0);
    expect(g[g.length - 1]).toBe(2667);
    expect(g.length).toBe(81);
  });
  it("a zero-length clip still has a key", () => {
    expect(sampleGrid(0).length).toBe(2);
  });
});

describe("the loops flag", () => {
  it("is the inverse of bit 0", () => {
    expect(0x820 & SEQ_ONE_SHOT).toBe(0);
    expect(0x8a1 & SEQ_ONE_SHOT).toBe(1);
  });
});

describe("UV sources per unit, from the shader id", () => {
  it("decodes retail's bitfield ids", () => {
    expect(unitUvSources(1, 0)).toEqual([0]);
    expect(unitUvSources(1, 0x4000)).toEqual([1]);
    expect(unitUvSources(1, 0x90)).toEqual([2]);
    expect(unitUvSources(2, 0x4011)).toEqual([0, 1]);
    expect(unitUvSources(2, 0x10)).toEqual([0, 0]);
    expect(unitUvSources(2, 0x8)).toEqual([0, 2]);
  });
  it("uses the table for ids with the high bit", () => {
    expect(unitUvSources(2, 0x8000)).toEqual([0, 2]);
    // Guild_Opaque with six texture slots: the program reads three, the rest default.
    expect(unitUvSources(6, 0x801c)).toEqual([0, 1, 0, 0, 0, 0]);
  });
});

describe("animation names", () => {
  it("knows the common ids and falls back", () => {
    expect(animName(0)).toBe("Stand");
    expect(animName(4)).toBe("Walk");
    expect(animName(60)).toBe("EmoteTalk");
    expect(animName(999999)).toBe("Anim 999999");
  });
});

describe("body GLB", () => {
  const model = new M2Model(m2);
  const skin = parseSkin(skinBytes);

  it("keeps one primitive and one material per batch, over one vertex stream", async () => {
    const built = buildBodyGlb(model, skin);
    const g = await readGlb(built.glb);
    const prims = g.json.meshes[0].primitives;
    expect(prims.length).toBe(2);
    expect(g.json.materials.length).toBe(2);
    expect(new Set(prims.map((p: any) => p.attributes.POSITION)).size).toBe(1);
    expect(prims[0].material).not.toBe(prims[1].material);
  });

  it("writes SubmeshExtras exactly", async () => {
    const g = await readGlb(buildBodyGlb(model, skin).glb);
    expect(g.json.materials[0].extras).toEqual({
      hash: 0,
      geoset: 0,
      units: [{ tex: 0, uvSet: 0, wrapS: true, wrapT: true, uvAnim: -1 }],
      shader: 0,
      blend: 2,
      flags: 4,
      priority: 0,
      color: -1,
      opacity: 0,
    });
    expect(g.json.materials[1].extras).toMatchObject({ hash: 1, geoset: 401, shader: 0x4011, priority: 1 });
    expect(g.json.materials[1].extras.units.map((u: any) => u.uvSet)).toEqual([0, 1]);
  });

  it("names joints b<n>, identity rest, no inverse binds, mesh not a joint", async () => {
    const g = await readGlb(buildBodyGlb(model, skin).glb);
    const nodes = g.json.nodes;
    expect(nodes.slice(0, 3).map((n: any) => n.name)).toEqual(["b0", "b1", "b2"]);
    for (const n of nodes) {
      expect(n.translation).toBeUndefined();
      expect(n.rotation).toBeUndefined();
      expect(n.scale).toBeUndefined();
    }
    expect(nodes[0].children).toEqual([1]);
    expect(nodes[1].children).toEqual([2]);
    expect(g.json.skins[0].joints).toEqual([0, 1, 2]);
    expect(g.json.skins[0].inverseBindMatrices).toBeUndefined();
    expect(g.json.animations).toBeUndefined();
  });

  it("reproduces positions, normals, UVs, joints, weights and exact triangles", async () => {
    const g = await readGlb(buildBodyGlb(model, skin).glb);
    const attrs = g.json.meshes[0].primitives[0].attributes;
    const pos = readAccessor(g, attrs.POSITION);
    const uv = readAccessor(g, attrs.TEXCOORD_0);
    const nor = readAccessor(g, attrs.NORMAL);
    const joints = readAccessor(g, attrs.JOINTS_0);
    const weights = readAccessor(g, attrs.WEIGHTS_0);
    expect(pos.count).toBe(4);
    const source = [
      [[0, 0, 0], [255, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 1], [128, 127, 0, 0], [0, 1, 0, 0]],
      [[0, 0, 2], [0, 255, 0, 0], [0, 1, 0, 0]],
      [[0.5, 0, 2], [0, 100, 155, 0], [0, 1, 2, 0]],
    ] as const;
    const read = (i: number) => Array.from(pos.values.subarray(i * 3, i * 3 + 3));
    const key = (p: readonly number[]) => p.map((v) => v.toFixed(3)).join();
    const byPos = new Map(source.map((s, i) => [key([s[0][1], s[0][2], s[0][0]]), i]));
    const remap: number[] = [];
    for (let i = 0; i < 4; i++) {
      const src = byPos.get(key(read(i)))!;
      expect(src).toBeDefined();
      remap[i] = src;
      expect(Math.round(weights.values[i * 4]! * 255)).toBe(source[src]![1][0]);
      expect(Math.round(weights.values[i * 4 + 2]! * 255)).toBe(source[src]![1][2]);
      expect(joints.values[i * 4 + 1]).toBe(source[src]![1][1] ? 1 : 0);
      expect(uv.values[i * 2]).toBeCloseTo(0.25, 3);
      expect(uv.values[i * 2 + 1]).toBeCloseTo(0.75, 3);
      // Retail normal +Z is target +Y.
      expect(nor.values[i * 3 + 1]).toBeGreaterThan(0.99);
    }
    const tris = g.json.meshes[0].primitives.map((p: any) => {
      const a = readAccessor(g, p.indices);
      return [...a.values].map((v) => remap[v]);
    });
    const sortTri = (t: number[]) => {
      // Rotations of a triangle are the same triangle; winding must survive.
      const m = t.indexOf(Math.min(...t));
      return [t[m], t[(m + 1) % 3], t[(m + 2) % 3]];
    };
    expect(sortTri(tris[0]!)).toEqual([0, 1, 2]);
    expect(sortTri(tris[1]!)).toEqual([1, 2, 3]);
  });

  it("bounds cover only the geosets asked for, in target axes", () => {
    const b = geosetBounds(model, skin, new Set([0]));
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([0, 2, 0]);
    const all = geosetBounds(model, skin, new Set([0, 401]));
    expect(all.max).toEqual([0, 2, 0.5]);
  });
});

describe("clip GLB", () => {
  const model = new M2Model(m2);

  it("survives compression within the stated tolerance", async () => {
    const seq = model.sequences[0]!;
    const buffers = await model.clipBuffers(seq, async () => null);
    const grid = sampleGrid(seq.durationMs);
    const s = sampleClip(model, seq, buffers, grid, { short: 0 });
    const glb = buildClipGlb("0.0", s);
    const g = await readGlb(glb);
    expect(g.json.animations.length).toBe(1);
    expect(g.json.meshes).toBeUndefined();
    expect(g.json.nodes.every((n: any) => /^b\d+$/.test(n.name))).toBe(true);
    const clip = new ClipReader(g);
    expect(clip.has(0, "rotation")).toBe(false);
    expect(clip.has(0, "translation")).toBe(true);

    const parents = model.bones.map((b) => b.parent);
    let worst = 0;
    for (const pose of (fx.poses as { seq: number; t: number; matrices: number[][] }[]).filter((p) => p.seq === 0)) {
      // Only at key times: this clip has a sharp corner between keys.
      if (!grid.some((t) => Math.abs(t - pose.t) < 1e-6)) continue;
      const world = worldMatrices(parents, (b) => clip.local(b, pose.t / 1000));
      pose.matrices.forEach((m, b) => {
        const want = retailToTarget(m);
        const here = [0.1, 0.2, 0.3];
        const a = apply(want, here);
        const c = apply(world[b]!, here);
        worst = Math.max(worst, Math.hypot(a[0]! - c[0]!, a[1]! - c[1]!, a[2]! - c[2]!));
      });
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it("has exact input ranges and a shared time accessor", async () => {
    const seq = model.sequences[0]!;
    const buffers = await model.clipBuffers(seq, async () => null);
    const s = sampleClip(model, seq, buffers, sampleGrid(seq.durationMs), { short: 0 });
    const g = await readGlb(buildClipGlb("0.0", s));
    const input = g.json.accessors[g.json.animations[0].samplers[0].input];
    expect(input.min).toEqual([0]);
    expect(input.max).toEqual([1]);
    const inputs = new Set(g.json.animations[0].samplers.map((x: any) => x.input));
    expect(inputs.size).toBeLessThanOrEqual(2);
  });
});
