import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelManifest } from "@eclipse/format";
import { describe, expect, it } from "vitest";
import { bodyClipWanted } from "../src/bake/clips";
import { LOCAL_PACKS, WORK } from "../src/lib/env";
import { M2Model, parseSkin } from "../src/m2/model";
import { parseDeps } from "../src/m2/chunks";
import { ClipReader, apply, readAccessor, readGlb, retailToTarget, worldMatrices } from "./lib/glb";

/**
 * The baked Human male against Eclipse's own evaluator (gen_human_male.py). Reads
 * whatever `pnpm bake run --scope human-male` last wrote to site/public/packs.
 * Baked files aren't committed, so this skips, loudly, on a checkout with none.
 *
 * Stated tolerances (target axes, in model units, about a metre):
 *   at a key time    1.5 mm, what compression leaves: 16-bit translation, 14-bit rotation
 *   between keys     12 mm, what 30 fps linear keys leave on a fast limb
 */
const KEY_TOL = 1.5e-3;
const MID_TOL = 12e-3;

const golden = JSON.parse(readFileSync(new URL("./fixtures/golden-human-male.json", import.meta.url), "utf8"));
const manifestPath = join(LOCAL_PACKS, "models", "human-male", "manifest.json");
const baked = existsSync(manifestPath);
if (!baked) console.warn(`SKIPPED golden Human male: no ${manifestPath}. Run: pnpm bake run --scope human-male --shard 0 --shards 1 --source wago`);

const object = (key: string) => readFileSync(join(LOCAL_PACKS, ...key.split("/")));

describe.skipIf(!baked)("baked Human male", () => {
  const manifest = (baked ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}) as ModelManifest;

  it("was baked from the build the goldens came from", () => {
    expect(manifest.build).toBe(golden.build);
    expect(manifest.boneCount).toBe(golden.parents.length);
    expect(manifest.source.m2).toBe(1011653);
  });

  for (const clipGolden of golden.clips as { id: string; poses: { kind: string; t: number; matrices: number[][]; vertices: number[] }[] }[]) {
    it(`clip ${clipGolden.id}: bones and skinned vertices match Eclipse, after quantization`, async () => {
      const entry = manifest.clips.find((c) => c.id === clipGolden.id);
      expect(entry, `clip ${clipGolden.id} is in the manifest`).toBeDefined();
      const clip = new ClipReader(await readGlb(object(entry!.key)));

      const body = await readGlb(object(manifest.glb.key));
      const attrs = body.json.meshes[0].primitives[0].attributes;
      const pos = readAccessor(body, attrs.POSITION);
      const joints = readAccessor(body, attrs.JOINTS_0);
      const weights = readAccessor(body, attrs.WEIGHTS_0);

      // Find each golden vertex by its bind position and skin. Order isn't part of
      // the contract: the writer orders vertices for the codec.
      const match: number[] = golden.vertices.map((v: { bind: number[]; weights: number[]; joints: number[] }) => {
        const p = [v.bind[1]!, v.bind[2]!, v.bind[0]!];
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < pos.count; i++) {
          const dx = pos.values[i * 3]! - p[0]!;
          const dy = pos.values[i * 3 + 1]! - p[1]!;
          const dz = pos.values[i * 3 + 2]! - p[2]!;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) {
            let same = true;
            for (let c = 0; c < 4; c++) {
              const w = v.weights[c]!;
              if (Math.round(weights.values[i * 4 + c]! * 255) !== w) same = false;
              if (w && joints.values[i * 4 + c] !== v.joints[c]) same = false;
            }
            if (same) {
              best = i;
              bestD = d;
            }
          }
        }
        expect(best, "a baked vertex with this skin exists").toBeGreaterThanOrEqual(0);
        expect(Math.sqrt(bestD), "bind position within the mesh's precision").toBeLessThan(5e-4);
        return best;
      });

      let worstKeyBone = 0;
      let worstKeyVert = 0;
      let worstMidVert = 0;
      for (const pose of clipGolden.poses) {
        const world = worldMatrices(golden.parents, (b) => clip.local(b, pose.t / 1000));

        if (pose.kind === "key") {
          (golden.bones as number[]).forEach((b, k) => {
            const want = retailToTarget(pose.matrices[k]!);
            // Compare what a matrix does to points around the joint: elements alone
            // would weigh a rotation and a translation alike.
            for (const q of [[0, 0, 0], [0.3, 0, 0], [0, 0.3, 0], [0, 0, 0.3]]) {
              const a = apply(want, q);
              const c = apply(world[b]!, q);
              worstKeyBone = Math.max(worstKeyBone, Math.hypot(a[0]! - c[0]!, a[1]! - c[1]!, a[2]! - c[2]!));
            }
          });
        }

        match.forEach((vi, s) => {
          const want = [pose.vertices[s * 3 + 1]!, pose.vertices[s * 3 + 2]!, pose.vertices[s * 3]!];
          const p = [pos.values[vi * 3]!, pos.values[vi * 3 + 1]!, pos.values[vi * 3 + 2]!];
          const out = [0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const w = weights.values[vi * 4 + c]!;
            if (!w) continue;
            const q = apply(world[joints.values[vi * 4 + c]!]!, p);
            out[0]! += q[0]! * w;
            out[1]! += q[1]! * w;
            out[2]! += q[2]! * w;
          }
          const d = Math.hypot(out[0]! - want[0]!, out[1]! - want[1]!, out[2]! - want[2]!);
          if (pose.kind === "key") worstKeyVert = Math.max(worstKeyVert, d);
          else worstMidVert = Math.max(worstMidVert, d);
        });
      }
      console.log(`clip ${clipGolden.id}: worst bone point ${(worstKeyBone * 1000).toFixed(2)} mm, vertex at a key ${(worstKeyVert * 1000).toFixed(2)} mm, between keys ${(worstMidVert * 1000).toFixed(2)} mm`);
      expect(worstKeyBone).toBeLessThan(KEY_TOL);
      expect(worstKeyVert).toBeLessThan(KEY_TOL);
      expect(worstMidVert).toBeLessThan(MID_TOL);
    });
  }

  it("keeps every submesh and exact triangle counts against the raw skin", async () => {
    const body = await readGlb(object(manifest.glb.key));
    const prims = body.json.meshes[0].primitives;
    const raw = join(WORK, "raw", golden.build);
    if (!existsSync(join(raw, "1011653"))) return;
    const deps = parseDeps(readFileSync(join(raw, "1011653")));
    const skin = parseSkin(readFileSync(join(raw, String(deps.skin[0]))));
    expect(prims.length).toBe(skin.batches.length);
    expect(body.json.materials.length).toBe(skin.batches.length);
    const total = prims.reduce((n: number, p: { indices: number }) => n + body.json.accessors[p.indices].count, 0);
    expect(total).toBe(skin.submeshes.reduce((n, s) => n + s.indexCount, 0));
    const geosets = new Set(body.json.materials.map((m: { extras: { geoset: number } }) => m.extras.geoset));
    for (const s of skin.submeshes) expect(geosets.has(s.id)).toBe(true);
  });

  it("winds outward: a closed mesh's signed volume is positive after the axis change", async () => {
    const body = await readGlb(object(manifest.glb.key));
    const prims = body.json.meshes[0].primitives;
    const pos = readAccessor(body, prims[0].attributes.POSITION).values;
    // Geoset 0 is the closed base body.
    let volume = 0;
    prims.forEach((p: { indices: number; material: number }) => {
      if (body.json.materials[p.material].extras.geoset !== 0) return;
      const idx = readAccessor(body, p.indices).values;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = idx[i]! * 3;
        const b = idx[i + 1]! * 3;
        const c = idx[i + 2]! * 3;
        const ax = pos[a]!, ay = pos[a + 1]!, az = pos[a + 2]!;
        const bx = pos[b]!, by = pos[b + 1]!, bz = pos[b + 2]!;
        const cx = pos[c]!, cy = pos[c + 1]!, cz = pos[c + 2]!;
        volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      }
    });
    expect(volume).toBeGreaterThan(0);
  });

  it("resolved the default look through the tables", () => {
    // Retail stores no look for a body: Eclipse's first choices, with hair and a beard (chr/tree.ts).
    expect(manifest.defaultGeosets).toEqual([0, 2, 102, 401, 501, 702, 1301, 1801, 2001, 2201, 3202, 3301, 5101]);
    expect(manifest.look?.[11]).toBe(45);
    expect(manifest.look?.[13]).toBe(77);
    expect(manifest.composite?.layers.length).toBeGreaterThanOrEqual(4);
    expect(manifest.composite?.width).toBe(1024);
    const eyes = manifest.textures.find((t) => t.type === 19);
    expect(eyes?.fileDataId).toBe(3484643);
    const hair = manifest.textures.find((t) => t.type === 6);
    expect(hair?.fileDataId).toBe(3582341);
  });

  it("computes bounds from the default vertices, not retail's header", () => {
    expect(manifest.bounds.max[1]).toBeGreaterThan(1.9);
    expect(manifest.bounds.max[1]).toBeLessThan(2.2);
    expect(manifest.bounds.min[1]).toBeGreaterThan(-0.1);
    // The body stands facing +Z, shoulders along X.
    expect(manifest.bounds.max[0] - manifest.bounds.min[0]).toBeGreaterThan(manifest.bounds.max[2] - manifest.bounds.min[2]);
  });

  it("marks looping from the sequence flag", () => {
    const by = (id: string) => manifest.clips.find((c) => c.id === id);
    expect(by("0.0")?.loops).toBe(true);
    expect(by("5.0")?.loops).toBe(true);
    expect(by("1.0")?.loops).toBe(false);
    expect(by("0.0")?.name).toBe("Stand");
    // Retail's customization screen reads StandCharacterCreate, within 2.4 mm of Stand on this body.
    expect(manifest.defaultClip).toBe("804.0");
    expect(by("804.0")?.name).toBe("StandCharacterCreate");
  });

  it("skips aliases and writes every clip that isn't one", () => {
    const raw = join(WORK, "raw", golden.build, "1011653");
    if (!existsSync(raw)) return;
    const deps = parseDeps(readFileSync(raw));
    const model = new M2Model(readFileSync(raw), readFileSync(join(WORK, "raw", golden.build, String(deps.skel[0]))));
    const wanted = model.sequences.filter((s) => !s.alias && bodyClipWanted(s.id));
    expect(manifest.clips.length).toBe(wanted.length);
    // No clip goes by a number: the nine retail hasn't named are left out with the rest of the internals.
    expect(manifest.clips.filter((c) => /^Anim /.test(c.name))).toEqual([]);
    expect(new Set(manifest.clips.map((c) => c.id)).size).toBe(manifest.clips.length);
  });
});
