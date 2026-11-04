import { BUILD, FORMAT_VERSION, type ClipEntry, type ModelKind, type ModelManifest, type TextureEntry, type TextureKind, paths } from "@eclipse/format";
import { buildBodyGlb, geosetBounds } from "../gltf/body";
import { buildClipGlb } from "../gltf/clip";
import { emitterWarnings } from "../fx/emitters";
import { encoderReady } from "../gltf/writer";
import { STAGE, inputKey, log, mapLimit } from "../lib/env";
import { animName } from "../m2/animNames";
import { chunk, parseDeps } from "../m2/chunks";
import { M2Model, SEQ_ONE_SHOT, type Sequence, type Skin, parentSkeletonOf, parseSkin } from "../m2/model";
import { type KeyStats, type SampledClip, globalLoopMotion, sampleClip, sampleGrid } from "../m2/sample";
import { MissingFile } from "../sources/source";
import { clipWanted } from "./clips";
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
  /** Fields only this kind of model carries: a body's look, its customization. */
  manifest?: Partial<ModelManifest>;
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
  /** The clip to start on when this model has it: a body's customization stand. */
  preferClip?: string;
  /**
   * Which sequences are baked. Absent: `clipWanted(kind)` decides. A piece of armour has
   * dozens of cuts and one useful clip, so what it plays is one small file or none.
   */
  clipFilter?: (seq: Sequence) => boolean;
  /** The clip is left out when no bone moves off its bind pose: that clip is identity anyway. */
  skipStaticClips?: boolean;
  /** The manifest is returned for the caller to embed, and no object of its own is written. */
  inline?: boolean;
  /** Written into the manifest, for a mount's rider. */
  displayScale?: number;
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
    const wanted = spec.clipFilter ?? clipWanted(spec.kind);
    for (const seq of model.sequences) {
      if (seq.alias) {
        aliases++;
        continue;
      }
      if (!wanted(seq)) continue;
      const id = `${seq.id}.${seq.variation}`;
      if (seen.has(id)) {
        warnings.push(`sequence ${id} appears twice; kept the first`);
        continue;
      }
      seen.add(id);
      if (ctx.onlyClips && !ctx.onlyClips.has(id)) continue;
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
    let isStatic = false;
    let bytes = ctx.force ? null : await ctx.store.stat(key);
    if (bytes === null) {
      const buffers = await model.clipBuffers(seq, loadAnim);
      if (buffers.form === "missing") {
        failed = true;
      } else {
        const sampled = sampleClip(model, seq, buffers, sampleGrid(seq.durationMs), stats);
        globalLoopBones = Math.max(globalLoopBones, sampled.globalLoopBones);
        if (spec.skipStaticClips && staysInBindPose(sampled)) {
          isStatic = true;
        } else {
          const body = buildClipGlb(id, sampled);
          await ctx.store.put(key, body);
          bytes = body.length;
        }
      }
    }
    if (failed) {
      warnings.push(`clip ${id} (${animName(seq.id)}): .anim ${animFdid} unavailable, not baked`);
      return null;
    }
    if (isStatic || bytes === null) return null;
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
  // Measured on Human male: 38 of its 39 global-loop tracks hold one value, and the last
  // is a 3 % scale over a 25-minute loop, so a clip restarting them changes nothing. Only a
  // track that visibly moves is worth a line in the report.
  void globalLoopBones;
  const moving = globalLoopMotion(model);
  if (moving) warnings.push(`${moving} bone track(s) move on a global loop under a minute: baked into each clip's time, so they restart with the clip`);
  if (aliases) log(`  ${spec.id}: ${aliases} alias sequences skipped`);

  // ---------------------------------------------------------------- fx, phys
  const fxKey = `objects/${inputKey("fx", STAGE.fx, skelId)}.json`;
  // Most armour animates nothing: no fx is no object and no fetch.
  let fxBytes = ctx.force ? null : await ctx.store.stat(fxKey);
  if (fxBytes === null) {
    const fx = await buildFx(
      model,
      clipSeqs,
      async (seq) => (await model.clipBuffers(seq, loadAnim)).model,
      stats,
    );
    if (!fxIsEmpty(fx)) {
      const body = Buffer.from(JSON.stringify(fx));
      await ctx.store.put(fxKey, body);
      fxBytes = body.length;
    }
  }
  if (stats.short) warnings.push(`${stats.short} keyframe array(s) overrun their .anim (bones added after the file was cut): those tracks hold`);
  warnings.push(...emitterWarnings(model));
  const billboard = model.bones.filter((b) => b.flags & 0x78).length;
  if (billboard) warnings.push(`${billboard} billboard bone(s): camera-facing behaviour is not in the clips`);
  if (deps.recursive.length || deps.geometryParticle.length) warnings.push(`model references ${deps.recursive.length + deps.geometryParticle.length} recursive or geometry-particle model(s), not baked yet`);

  let phys: { key: string; bytes: number } | undefined;
  const physFdid = deps.phys[0];
  // Nearly every physics model carries it inline (PFDC); PFID names a file (one measured
  // of the 8,240 emitter or physics models in the local cache).
  const inlinePhys = chunk(model.chunks, "PFDC");
  if (inlinePhys) {
    const key = `objects/${inputKey("phys", STAGE.phys, m2File.id, "PFDC")}.phys`;
    phys = { key, bytes: await putIfAbsent(ctx, key, () => inlinePhys) };
  } else if (physFdid) {
    try {
      const f = await files.read(physFdid);
      const key = `objects/${inputKey("phys", STAGE.phys, f.id)}.phys`;
      phys = { key, bytes: await putIfAbsent(ctx, key, () => f.bytes) };
    } catch (e) {
      warnings.push(`.phys ${physFdid} could not be read: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- manifest
  const defaultClip = clips.find((c) => c.id === spec.preferClip)?.id ?? clips.find((c) => c.id === "0.0")?.id ?? clips[0]?.id ?? "";
  if (!defaultClip && !spec.noClips) warnings.push("no clip was baked");

  const manifest: ModelManifest = {
    formatVersion: FORMAT_VERSION,
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    build: BUILD.version,
    source: { m2: spec.m2, skin: deps.skin[0], ...(skelFdid ? { skel: skelFdid } : {}) },
    glb: { key: glbKey, bytes: glbBytes },
    ...(fxBytes !== null ? { fx: { key: fxKey, bytes: fxBytes } } : {}),
    ...(phys ? { phys } : {}),
    bounds,
    boneCount: model.bones.length,
    // A collection's nodes are the body's: only a model that plays its own clips needs these.
    ...(spec.noClips && !phys ? {} : { pivots: pivotsOf(model) }),
    clips,
    defaultClip,
    textures: look.textures,
    defaultGeosets: [...look.geosets].sort((a, b) => a - b),
    ...(look.composite ? { composite: look.composite } : {}),
    attachments: model.attachments.map((a) => ({ id: a.id, bone: a.bone, position: [a.position[1], a.position[2], a.position[0]] })),
    warnings: [...new Set(warnings)],
    ...look.manifest,
    boneCrcs: model.bones.map((b) => b.crc),
    defaultTextures: defaultTextures(model, skin, look.geosets, look.textures),
    ...(spec.displayScale !== undefined ? { displayScale: spec.displayScale } : {}),
  };
  if (!spec.inline) await ctx.store.put(paths.manifest(spec.id), Buffer.from(JSON.stringify(manifest)));

  return { manifest, sizes: sizesOf(manifest, model, skin, look.geosets), inputs: files.inputs };
}

/** A sampled clip drops every track equal to the rest pose. Nothing left: it draws the bind pose. */
export function staysInBindPose(clip: SampledClip): boolean {
  return clip.tracks.length === 0;
}

/** The textures the visible batches read and the file holds: fetched first, the rest when shown. */
export function defaultTextures(model: M2Model, skin: Skin, visible: ReadonlySet<number>, textures: readonly TextureEntry[]): number[] {
  const used = new Set<number>();
  for (const b of skin.batches) {
    const s = skin.submeshes[b.submesh];
    if (!s || !visible.has(s.id)) continue;
    for (let k = 0; k < b.textureCount; k++) {
      const t = model.texLookup[b.textureCombo + k];
      if (t !== undefined && t >= 0 && textures[t]?.key) used.add(t);
    }
  }
  return [...used].sort((a, b) => a - b);
}

/** Nothing moves and nothing emits. */
export function fxIsEmpty(fx: object): boolean {
  return Object.values(fx).every((v) => !Array.isArray(v) || v.length === 0);
}

/** Flat xyz per retail bone, in the baker's axes. 0.01 mm is far below a pixel, and these digits are bytes. */
function pivotsOf(model: M2Model): number[] {
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return model.bones.flatMap((b) => [round(b.pivot[1]), round(b.pivot[2]), round(b.pivot[0])]);
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
