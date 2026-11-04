import sharp from "sharp";
import { BUILD, type ModelManifest, type TextureEntry } from "@eclipse/format";
import { type BakeContext, type BakeRecord, Tracked, writeRecord } from "../bake/context";
import { type ModelLook, bakeModel, blankTexture } from "../bake/model";
import { bakeTexture } from "../bake/texture";
import { groupBy, num } from "../db2/db2";
import { particleColorsOf } from "../fx/emitters";
import { BAKER_VERSION, STAGE, inputKey, log } from "../lib/env";
import { MissingPart, failedObjects, texturesInUse } from "../items/bake";
import type { M2Model, Skin } from "../m2/model";
import { MissingFile } from "../sources/source";
import { blpInfo, blpLevelUnder, decodeBlp } from "../tex/blp";
import { ETC1S_QUALITY, encodeKtx2 } from "../tex/ktx2";
import { type ChrLook, resolveChrLook } from "./chr";
import type { MountFamily, MountVariantSpec } from "./scan";

/** A mount fills the stage: its art earns more than an item's. */
const MOUNT_TEXTURE_CAP = 1024;
const ICON_SIZE = 64;
/** Which texture type each CreatureDisplayInfo variation paints. Type 5 is retail's fourth (mount_convert.py). */
const SKIN_TYPES: Record<number, number> = { 11: 0, 12: 1, 13: 2, 5: 3 };

export function modelIdOfDisplay(display: number): string {
  return `mountd-${display}`;
}

/**
 * Retail's creature geosets (12.1.0.69933 0x10006E9F0): with CreatureGeosetDataID set,
 * 1..3299 hide, and each CreatureDisplayInfoGeosetData row shows its group's value.
 * Otherwise nothing hides. A character-model mount shows what its choices name, and 0.
 */
export function creatureGeosets(ids: readonly number[], geosetData: number, rows: readonly { index: number; value: number }[]): Set<number> {
  if (!geosetData) return new Set(ids);
  const shown = new Set(rows.map((r) => (r.index + 1) * 100 + r.value));
  return new Set(ids.filter((id) => id === 0 || id > 3299 || shown.has(id)));
}

export function chrGeosets(ids: readonly number[], chosen: ReadonlySet<number>): Set<number> {
  return new Set(ids.filter((id) => id === 0 || id < 100 || chosen.has(id)));
}

function blend(dst: Float32Array, src: Float32Array, mode: number): void {
  for (let i = 0; i < dst.length; i += 4) {
    const sa = src[i + 3]!;
    for (let c = 0; c < 3; c++) {
      const d = dst[i + c]!;
      const s = src[i + c]!;
      let v: number;
      switch (mode) {
        case 0:
        case 1:
          v = s;
          break;
        case 4:
          v = d * s;
          break;
        case 6:
          v = d < 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s);
          break;
        case 7:
          v = 1 - (1 - d) * (1 - s);
          break;
        default:
          v = s;
      }
      dst[i + c] = mode === 0 || mode === 1 ? v : d + (v - d) * sa;
    }
    dst[i + 3] = mode === 0 || mode === 1 ? sa : Math.max(dst[i + 3]!, sa);
  }
}

/** Layers no slot can read one by one are composited once, here, as retail would at run time. */
async function compositeObject(ctx: BakeContext, files: Tracked, layers: [number, number][]): Promise<TextureEntry> {
  const read = await Promise.all(layers.map(async ([mode, fdid]) => ({ mode, file: await files.read(fdid) })));
  const key = `objects/${inputKey("mountcomp", STAGE.tex, ETC1S_QUALITY, ...read.map((r) => `${r.mode}:${r.file.id}`))}.ktx2`;
  const first = decodeBlp(read[0]!.file.bytes, blpLevelUnder(blpInfo(read[0]!.file.bytes), MOUNT_TEXTURE_CAP));
  const [w, h] = [first.width, first.height];
  const canvas = new Float32Array(w * h * 4);
  for (const { mode, file } of read) {
    const img = decodeBlp(file.bytes, blpLevelUnder(blpInfo(file.bytes), MOUNT_TEXTURE_CAP));
    const bytes = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    const raw = img.width === w && img.height === h ? bytes : await sharp(bytes, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(w, h, { fit: "fill" }).raw().toBuffer();
    const src = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) src[i] = raw[i]! / 255;
    blend(canvas, src, mode);
  }
  const out = new Uint8Array(canvas.length);
  let alpha = false;
  for (let i = 0; i < canvas.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, canvas[i]!)) * 255);
  for (let i = 3; i < out.length; i += 4) if (out[i]! < 250) alpha = true;
  const ktx = await encodeKtx2({ width: w, height: h, data: out });
  await ctx.store.put(key, ktx);
  return { ...blankTexture(1), key, bytes: ktx.length, width: w, height: h, alpha };
}

async function variantLook(ctx: BakeContext, v: MountVariantSpec, chr: ChrLook | null, geosetRows: { index: number; value: number }[], model: M2Model, skin: Skin, files: Tracked): Promise<ModelLook> {
  const ids = [...new Set(skin.submeshes.map((s) => s.id))];
  const geosets = chr ? chrGeosets(ids, chr.geosets) : creatureGeosets(ids, v.geosetData, geosetRows);
  const used = texturesInUse(model, skin, geosets);
  const warnings: string[] = [];
  const textures: TextureEntry[] = [];
  for (let i = 0; i < model.textures.length; i++) {
    const tex = model.textures[i]!;
    const paint = chr?.textures.get(tex.type);
    const skinIndex = SKIN_TYPES[tex.type];
    const fdid = tex.type === 0 ? tex.fileDataId : paint && paint.kind !== "composite" ? paint.fdid : !chr && skinIndex !== undefined ? v.skins[skinIndex]! : 0;
    try {
      if (paint?.kind === "composite") {
        const made = await compositeObject(ctx, files, paint.layers);
        textures.push({ ...made, type: tex.type, kind: blankTexture(tex.type).kind });
        continue;
      }
      if (!fdid) {
        // A type no display fills paints nothing: a batch reading it is retail's problem too.
        textures.push(blankTexture(tex.type));
        continue;
      }
      const t = await bakeTexture(ctx, files, fdid, { cap: MOUNT_TEXTURE_CAP });
      textures.push({ ...blankTexture(tex.type), key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: fdid });
    } catch (e) {
      if (!(e instanceof MissingFile)) throw e;
      if (used.has(i)) throw new MissingPart(`texture ${fdid} of display ${v.display} cannot be read`);
      warnings.push(`texture ${fdid}: ${e.message}`);
      textures.push(blankTexture(tex.type));
    }
  }
  if (geosets.size === 0) throw new MissingPart(`display ${v.display} shows no submesh`);
  const row = model.particleCount ? (await ctx.db.where("CreatureDisplayInfo", "ID", v.display))[0] : undefined;
  const particleColors = row ? await particleColorsOf(ctx.db, model, num(row.ParticleColorID)) : undefined;
  return { geosets, textures, warnings, ...(particleColors ? { manifest: { particleColors } } : {}) };
}

async function iconObject(ctx: BakeContext, files: Tracked, fdid: number): Promise<string> {
  if (!fdid) return "";
  const known = await files.identity(fdid);
  if (known && !ctx.force) {
    const key = `objects/${inputKey("itemicon", STAGE.icon, known)}.webp`;
    if ((await ctx.store.stat(key)) !== null) return key;
  }
  const f = await files.read(fdid);
  const key = `objects/${inputKey("itemicon", STAGE.icon, f.id)}.webp`;
  if (ctx.force || (await ctx.store.stat(key)) === null) {
    const img = decodeBlp(f.bytes, blpLevelUnder(blpInfo(f.bytes), ICON_SIZE));
    const raw = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    await ctx.store.put(key, await sharp(raw, { raw: { width: img.width, height: img.height, channels: 4 } }).webp({ quality: 84, effort: 6 }).toBuffer());
  }
  return key;
}

function objectsOfModel(m: ModelManifest): string[] {
  return [m.glb.key, ...(m.fx ? [m.fx.key] : []), ...(m.phys ? [m.phys.key] : []), ...m.textures.map((t) => t.key).filter(Boolean), ...m.clips.map((c) => c.key)];
}

/** One animal: every colour the game gives it. A colour that cannot draw is left out and said; no colour at all fails the unit. */
export async function bakeMountUnit(ctx: BakeContext, family: MountFamily): Promise<BakeRecord> {
  const start = Date.now();
  const base = { id: family.id, kind: "mount", build: BUILD.version, baker: BAKER_VERSION, source: ctx.source.name, bakedAt: new Date().toISOString() };
  const warnings: string[] = [];
  const icons: Record<string, string> = {};
  const ok: number[] = [];
  const files = new Tracked(ctx.source);
  let firstError = "";
  const rows = groupBy(await ctx.db.table("CreatureDisplayInfoGeosetData"), "CreatureDisplayInfoID");
  let sizes: Record<string, number> = {};
  for (const v of family.variants) {
    try {
      const chr = await resolveChrLook(ctx, v.display);
      const geosetRows = (rows.get(String(v.display)) ?? []).map((g) => ({ index: num(g.GeosetIndex), value: num(g.GeosetValue) }));
      const baked = await bakeModel(ctx, {
        id: modelIdOfDisplay(v.display),
        kind: "mount",
        name: v.name,
        m2: v.m2,
        displayScale: v.scale,
        look: (model, skin, f) => variantLook(ctx, v, chr, geosetRows, model, skin, f),
      });
      warnings.push(...baked.manifest.warnings);
      const bad = failedObjects(ctx.store, objectsOfModel(baked.manifest));
      if (bad.length) throw new MissingPart(`${bad.length} object(s) failed their load check, first ${bad[0]}`);
      ok.push(v.display);
      sizes = baked.sizes;
      if (v.iconFdid && !icons[String(v.iconFdid)]) {
        const key = await iconObject(ctx, files, v.iconFdid).catch((e) => {
          if (e instanceof MissingFile) return "";
          throw e;
        });
        if (key) icons[String(v.iconFdid)] = key;
      }
    } catch (e) {
      if (e instanceof Error && e.name === "BudgetExceeded") throw e;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      warnings.push(`display ${v.display}: ${msg}`);
      firstError ||= msg;
    }
  }
  const seconds = (Date.now() - start) / 1000;
  if (!ok.length) {
    const rec: BakeRecord = { ...base, status: "failed", error: firstError || "no display could be baked", inputs: {}, warnings, seconds };
    await writeRecord(ctx.store, rec);
    return rec;
  }
  log(`  ${family.id}: ${family.name}, ${ok.length} of ${family.variants.length} colour(s)`);
  const rec: BakeRecord = { ...base, status: "ok", inputs: {}, warnings: [...new Set(warnings)], seconds, sizes, validated: true, icons, variants: ok };
  await writeRecord(ctx.store, rec);
  return rec;
}
