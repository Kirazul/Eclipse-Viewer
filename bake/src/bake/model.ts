import { BUILD, FORMAT_VERSION, type ClipEntry, type ModelKind, type ModelManifest, type TextureEntry, type TextureKind, paths } from "@eclipse/format";
import { buildBodyGlb, geosetBounds } from "../gltf/body";
import { buildClipGlb } from "../gltf/clip";
import { encoderReady } from "../gltf/writer";
import { STAGE, inputKey, log, mapLimit } from "../lib/env";
import { animName } from "../m2/animNames";
import { parseDeps } from "../m2/chunks";
import { M2Model, SEQ_ONE_SHOT, type Sequence, type Skin, parentSkeletonOf, parseSkin } from "../m2/model";
import { type KeyStats, sampleClip, sampleGrid } from "../m2/sample";
import { MissingFile } from "../sources/source";
import { type BakeContext, Tracked } from "./context";
import { buildFx } from "./fx";

export function kindOf(type: number): TextureKind {
  if (type === 0) return "static";
  if (type === 1) return "skin";
  if (type === 6) return "hair";
  if (type === 8) return "fur";
  if (type === 19) return "eyes";
  if (type >= 11 && type <= 13) return "monster";
  return "object";
}

export function blankTexture(type: number): TextureEntry {
  return { type, kind: kindOf(type), key: "", bytes: 0, width: 0, height: 0, alpha: false };
}

export async function putIfAbsent(ctx: BakeContext, key: string, make: () => Promise<Uint8Array> | Uint8Array): Promise<number> {
  if (!ctx.force) {
    const size = await ctx.store.stat(key);
    if (size !== null) return size;
  }
  const body = await make();
  await ctx.store.put(key, body);
  return body.length;
}

/** What differs between a body and a piece of armour. */
export interface ModelLook {
  geosets: Set<number>;
  textures: TextureEntry[];
  composite?: ModelManifest["composite"];
  warnings: string[];
}

export interface ModelSpec {
  id: string;
  kind: ModelKind;
  name: string;
  m2: number;
  /** A collection plays the body's clips, on the body's bones. */
  noClips?: boolean;
  /** A collection's joints take the body's names. Absent: its own `b<n>`. */
  jointName?: (bone: number) => string;
  /** Goes into the geometry's key whenever `jointName` is given. */
  jointKey?: string;
  look(model: M2Model, skin: Skin, files: Tracked): Promise<ModelLook>;
}

export interface BakedModel {
  manifest: ModelManifest;
  sizes: Record<string, number>;
  inputs: Record<string, string>;
}

/** The skeleton and skin of a model, with its inputs tracked. */
export async function readModelFiles(files: Tracked, m2Fdid: number) {
  const m2 = await files.read(m2Fdid);
  const deps = parseDeps(m2.bytes);
  const skelFdid = deps.skel[0];
  const skel = skelFdid ? await files.read(skelFdid) : null;
  const parentFdid = skel ? parentSkeletonOf(skel.bytes) : 0;
  const parent = parentFdid ? await files.read(parentFdid) : null;
  const model = new M2Model(m2.bytes, skel?.bytes, parent?.bytes);
  return { m2, deps, skelFdid, skel, parent, model };
}

/**
 * Bakes one model. Objects go up as they are finished and the manifest goes last,
 * so a job that dies leaves no manifest and the rerun skips what is already there.
 */
export async function bakeModel(ctx: BakeContext, spec: ModelSpec): Promise<BakedModel> {
  await encoderReady();
  const files = new Tracked(ctx.source);
  const warnings: string[] = [];

  const { m2: m2File, deps, skelFdid, skel, parent, model } = await readModelFiles(files, spec.m2);
  if (!deps.skin[0]) throw new Error(`model ${spec.m2} has no skin`);
  const skinFile = await files.read(deps.skin[0]);
  const skin: Skin = parseSkin(skinFile.bytes);

  // Everything skeleton-side, in one identity.
  const skelId = [m2File.id, skel?.id ?? "", parent?.id ?? ""].join("+");

  const look = await spec.look(model, skin, files);
  warnings.push(...look.warnings);

  // ---------------------------------------------------------------- geometry
  const glbKey = `objects/${inputKey("body", STAGE.body, m2File.id, skinFile.id, spec.jointKey ?? "")}.glb`;
  const glbBytes = await putIfAbsent(ctx, glbKey, () => buildBodyGlb(model, skin, spec.jointName).glb);
  const bounds = geosetBounds(model, skin, look.geosets);

  // ---------------------------------------------------------------- clips
  const clipSeqs: Sequence[] = [];
  const seen = new Set<string>();
  let aliases = 0;
  if (!spec.noClips) {
    for (const seq of model.sequences) {
      if (seq.alias) {
        aliases++;
        continue;
      }
      const id = `${seq.id}.${seq.variation}`;
      if (seen.has(id)) {
        warnings.push(`sequence ${id} appears twice; kept the first`);
        continue;
      }
      seen.add(id);
      clipSeqs.push(seq);
    }
  }

  const stats: KeyStats = { short: 0 };
  let globalLoopBones = 0;
  const unreadable = new Set<number>();
  const loadAnim = async (fdid: number): Promise<Buffer | null> => {
    if (unreadable.has(fdid)) return null;
    try {
      return (await files.read(fdid)).bytes;
    } catch (e) {
      if (!(e instanceof MissingFile)) throw e;
      unreadable.add(fdid);
      warnings.push(`.anim ${fdid} could not be read: ${e.message}`);
      return null;
    }
  };

  const clipResults = await mapLimit(clipSeqs, 4, async (seq): Promise<ClipEntry | null> => {
    const id = `${seq.id}.${seq.variation}`;
    const animFdid = model.animFileOf(seq);
    if (model.isExternalWithoutFile(seq)) {
      warnings.push(`clip ${id} (${animName(seq.id)}) is external with no file in AFID: not baked`);
      return null;
    }
    let animId = "";
    if (animFdid) {
      const known = await files.identity(animFdid);
      if (known) animId = known;
      else {
        if (!(await loadAnim(animFdid))) return null;
        animId = files.inputs[String(animFdid)] ?? "";
      }
    }
    const key = `objects/${inputKey("clip", STAGE.clip, skelId, animId, seq.level.name, seq.concrete, id)}.glb`;
    let failed = false;
    const bytes = await putIfAbsent(ctx, key, async () => {
      const buffers = await model.clipBuffers(seq, loadAnim);
      if (buffers.form === "missing") {
        failed = true;
        return new Uint8Array(0);
      }
      const sampled = sampleClip(model, seq, buffers, sampleGrid(seq.durationMs), stats);
      globalLoopBones = Math.max(globalLoopBones, sampled.globalLoopBones);
      return buildClipGlb(id, sampled);
    });
    if (failed) {
      await ctx.store.remove(key);
      warnings.push(`clip ${id} (${animName(seq.id)}): .anim ${animFdid} unavailable, not baked`);
      return null;
    }
    return {
      id,
      name: animName(seq.id),
      animId: seq.id,
      variation: seq.variation,
      durationMs: seq.durationMs,
      loops: (seq.flags & SEQ_ONE_SHOT) === 0,
      key,
      bytes,
    };
  });
  const clips = clipResults.filter((c): c is ClipEntry => c !== null);
  if (globalLoopBones) warnings.push(`${globalLoopBones} bone(s) run on a global loop: baked into each clip's time, so they restart with the clip`);
  if (aliases) log(`  ${spec.id}: ${aliases} alias sequences skipped`);

  // ---------------------------------------------------------------- fx, phys
  const fxKey = `objects/${inputKey("fx", STAGE.fx, skelId)}.json`;
  const fxBytes = await putIfAbsent(ctx, fxKey, async () => {
    const fx = await buildFx(
      model,
      clipSeqs,
      async (seq) => (await model.clipBuffers(seq, loadAnim)).model,
      stats,
    );
    return Buffer.from(JSON.stringify(fx));
  });
  if (stats.short) warnings.push(`${stats.short} keyframe array(s) overrun their .anim (bones added after the file was cut): those tracks hold`);
  if (model.particleCount) warnings.push(`${model.particleCount} particle emitter(s) not baked yet (later milestone)`);
  if (model.ribbonCount) warnings.push(`${model.ribbonCount} ribbon(s) not baked yet (later milestone)`);
  if (model.boneFiles.length) warnings.push(`${model.boneFiles.length} .bone file(s) (face bone sets) not carried yet: the bind pose of the default face is unadjusted`);
  const billboard = model.bones.filter((b) => b.flags & 0x78).length;
  if (billboard) warnings.push(`${billboard} billboard bone(s): camera-facing behaviour is not in the clips`);
  if (deps.recursive.length || deps.geometryParticle.length) warnings.push(`model references ${deps.recursive.length + deps.geometryParticle.length} recursive or geometry-particle model(s), not baked yet`);

  let phys: { key: string; bytes: number } | undefined;
  const physFdid = deps.phys[0];
  if (physFdid) {
    try {
      const f = await files.read(physFdid);
      const key = `objects/${inputKey("phys", STAGE.phys, f.id)}.phys`;
      phys = { key, bytes: await putIfAbsent(ctx, key, () => f.bytes) };
    } catch (e) {
      warnings.push(`.phys ${physFdid} could not be read: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- manifest
  const defaultClip = clips.find((c) => c.id === "0.0")?.id ?? clips[0]?.id ?? "";
  if (!defaultClip && !spec.noClips) warnings.push("no clip was baked");

  const manifest: ModelManifest = {
    formatVersion: FORMAT_VERSION,
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    build: BUILD.version,
    source: { m2: spec.m2, skin: deps.skin[0], ...(skelFdid ? { skel: skelFdid } : {}) },
    glb: { key: glbKey, bytes: glbBytes },
    fx: { key: fxKey, bytes: fxBytes },
    ...(phys ? { phys } : {}),
    bounds,
    boneCount: model.bones.length,
    clips,
    defaultClip,
    textures: look.textures,
    defaultGeosets: [...look.geosets].sort((a, b) => a - b),
    ...(look.composite ? { composite: look.composite } : {}),
    attachments: model.attachments.map((a) => ({ id: a.id, bone: a.bone, position: [a.position[1], a.position[2], a.position[0]] })),
    warnings: [...new Set(warnings)],
  };
  await ctx.store.put(paths.manifest(spec.id), Buffer.from(JSON.stringify(manifest)));

  return { manifest, sizes: sizesOf(manifest, model, skin, look.geosets), inputs: files.inputs };
}

function sizesOf(m: ModelManifest, model: M2Model, skin: Skin, visible: Set<number>): Record<string, number> {
  const clipBytes = m.clips.map((c) => c.bytes);
  const idle = m.clips.find((c) => c.id === m.defaultClip)?.bytes ?? 0;
  // What a viewer fetches to show the default look: the textures its visible batches
  // reference, and the composite's layers if any of them draws the composite.
  const usedTex = new Set<number>();
  for (const b of skin.batches) {
    const s = skin.submeshes[b.submesh];
    if (!s || !visible.has(s.id)) continue;
    for (let k = 0; k < b.textureCount; k++) {
      const t = model.texLookup[b.textureCombo + k];
      if (t !== undefined && t >= 0) usedTex.add(t);
    }
  }
  let direct = 0;
  let composite = 0;
  const counted = new Set<string>();
  for (const t of usedTex) {
    const e = m.textures[t];
    if (!e) continue;
    if (e.type === 1) {
      for (const l of m.composite?.layers ?? []) {
        if (!counted.has(l.key)) {
          counted.add(l.key);
          composite += l.bytes;
        }
      }
    } else if (e.key && !counted.has(e.key)) {
      counted.add(e.key);
      direct += e.bytes;
    }
  }
  return {
    glb: m.glb.bytes,
    fx: m.fx?.bytes ?? 0,
    idle,
    clipCount: clipBytes.length,
    clipsTotal: clipBytes.reduce((a, b) => a + b, 0),
    clipMin: clipBytes.length ? Math.min(...clipBytes) : 0,
    clipMax: clipBytes.length ? Math.max(...clipBytes) : 0,
    textureDirect: direct,
    textureComposite: composite,
    firstLoad: m.glb.bytes + (m.fx?.bytes ?? 0) + idle + direct + composite,
  };
}
