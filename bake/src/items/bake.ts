import sharp from "sharp";
import { BUILD, FORMAT_VERSION, type ItemEntry, type ItemManifest, type SlotId, type TextureEntry, paths } from "@eclipse/format";
import { type BakeContext, type BakeRecord, Tracked, writeRecord } from "../bake/context";
import { type BakedModel, type ModelLook, bakeModel, blankTexture, readModelFiles } from "../bake/model";
import { type BakedTexture, type Want, bakeTexture } from "../bake/texture";
import { type BodySpec, allBodies, allRaces } from "../chr/races";
import { num } from "../db2/db2";
import { BAKER_VERSION, STAGE, inputKey, log, md5Hex } from "../lib/env";
import type { M2Model, Skin } from "../m2/model";
import { MissingFile } from "../sources/source";
import { blpInfo, blpLevelUnder, decodeBlp } from "../tex/blp";
import { type GeosetFilter, type ModelFile, type ResolvedDisplay, attachmentFor, facetOf, geosetFilter, isCombined, isSkinnedModel, padBits, pickTexture, resolveDisplay, slotOfDisplayType } from "./resolve";

/** A model slot's texture cap on an item. Retail authors these at 1024 at most; a piece is rarely that big on screen. */
const ITEM_TEXTURE_CAP = 1024;
/** A body section on the 1024 x 512 canvas is at most 256 wide. */
const SECTION_CAP = 256;
const ICON_SIZE = 64;

export interface ItemSpec {
  displayId: number;
  itemId: number;
  name: string;
  slot: SlotId;
  line: string;
  iconFdid: number;
  inventoryType: number;
  facet?: string;
}

export function itemUnitId(displayId: number): string {
  return `item-${displayId}`;
}

/** The first item that wears this display, read through the tables. */
export async function specOfItem(ctx: BakeContext, itemId: number, line = ""): Promise<ItemSpec> {
  const db = ctx.db;
  const ima = (await db.where("ItemModifiedAppearance", "ItemID", itemId)).sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex))[0];
  if (!ima) throw new Error(`item ${itemId} has no appearance`);
  const app = (await db.where("ItemAppearance", "ID", ima.ItemAppearanceID ?? ""))[0];
  if (!app) throw new Error(`item ${itemId}: no ItemAppearance ${ima.ItemAppearanceID}`);
  const slot = slotOfDisplayType(num(app.DisplayType));
  if (!slot) throw new Error(`item ${itemId}: display type ${app.DisplayType} has no slot`);
  const item = (await db.where("Item", "ID", itemId))[0];
  const sparse = (await db.where("ItemSparse", "ID", itemId))[0];
  const expansion = num(sparse?.ExpansionID);
  const facet = item ? facetOf(num(item.ClassID), num(item.SubclassID)) : undefined;
  return {
    displayId: num(app.ItemDisplayInfoID),
    itemId,
    name: sparse?.Display_lang ?? `Item ${itemId}`,
    slot,
    line: line || (expansion === 11 ? "midnight" : expansion === 10 ? "warwithin" : `expansion-${expansion}`),
    iconFdid: num(app.DefaultIconFileDataID) || num(item?.IconFileDataID),
    inventoryType: num(item?.InventoryType),
    ...(facet ? { facet } : {}),
  };
}

function textureEntry(t: { key: string; bytes: number; width: number; height: number; alpha: boolean }, type: number, fdid: number): TextureEntry {
  return { ...blankTexture(type), key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: fdid };
}

/**
 * A texture, or a warning. At the pin wago answers zeros for some files the CDN has
 * (Midnight's set art, measured), so a missing texture must not lose the whole item.
 */
async function tryTexture(ctx: BakeContext, files: Tracked, fdid: number, want: Want, warnings: string[]): Promise<BakedTexture | null> {
  try {
    return await bakeTexture(ctx, files, fdid, want);
  } catch (e) {
    if (!(e instanceof MissingFile)) throw e;
    warnings.push(`texture ${fdid}: ${e.message}`);
    return null;
  }
}

/** The textures of one piece: hard-coded ones, then the display's for each texture type. */
async function pieceLook(ctx: BakeContext, d: ResolvedDisplay, file: ModelFile, filter: GeosetFilter, race: number, sex: number, model: M2Model, skin: Skin, files: Tracked): Promise<ModelLook> {
  const warnings: string[] = [];
  const textures: TextureEntry[] = [];
  for (const tex of model.textures) {
    let fdid = tex.type === 0 ? tex.fileDataId : 0;
    if (!fdid) {
      const extra = d.extraTextures.find((e) => e.type === tex.type && e.modelIndex === file.k);
      const list = extra?.files ?? (tex.type === 2 ? d.modelTextures[file.k] : undefined) ?? [];
      fdid = pickTexture(list, race, sex)?.fdid ?? 0;
    }
    if (!fdid) {
      textures.push(blankTexture(tex.type));
      continue;
    }
    const t = await tryTexture(ctx, files, fdid, { cap: ITEM_TEXTURE_CAP }, warnings);
    textures.push(t ? textureEntry(t, tex.type, fdid) : blankTexture(tex.type));
  }
  const geosets = new Set(skin.submeshes.map((s) => s.id).filter((id) => filter.keep(id)));
  if (geosets.size === 0) warnings.push(`no submesh of ${file.fdid} shows under ${filter.tag}`);
  return { geosets, textures, warnings };
}

/** The bone list of a body, by name hash: its M2 and .skel are large, so kept once baked. */
async function bodyBoneNames(ctx: BakeContext, body: BodySpec, memo: Map<string, Map<number, number>>): Promise<Map<number, number>> {
  const hit = memo.get(body.id);
  if (hit) return hit;
  const key = `objects/${inputKey("bones", STAGE.item, String(body.m2), BUILD.version)}.json`;
  const stored = await ctx.store.get(key);
  let crcs: number[];
  if (stored) {
    crcs = JSON.parse(stored.toString("utf8")) as number[];
  } else {
    const { model } = await readModelFiles(new Tracked(ctx.source), body.m2);
    crcs = model.bones.map((b) => b.crc);
    await ctx.store.put(key, Buffer.from(JSON.stringify(crcs)));
  }
  const names = new Map<number, number>();
  crcs.forEach((c, i) => {
    if (c && !names.has(c)) names.set(c, i);
  });
  memo.set(body.id, names);
  return names;
}

/** The file a body wears: its own race and sex, else a race-agnostic one. */
export function fileForBody(models: ModelFile[], raceId: number, sex: 0 | 1): ModelFile | undefined {
  const fits = (m: ModelFile) => m.classId === 0 && (m.sex === sex || (m.sex !== 0 && m.sex !== 1));
  return models.find((m) => m.race === raceId && fits(m)) ?? models.find((m) => m.race === 0 && fits(m));
}

function raceIdOf(races: Awaited<ReturnType<typeof allRaces>>, body: BodySpec): number {
  return races.find((r) => r.key === body.raceKey)?.raceId ?? 0;
}

async function iconObject(ctx: BakeContext, files: Tracked, fdid: number): Promise<string> {
  if (!fdid) return "";
  const f = await files.read(fdid);
  const key = `objects/${inputKey("itemicon", STAGE.icon, f.id)}.webp`;
  if (ctx.force || (await ctx.store.stat(key)) === null) {
    const info = blpInfo(f.bytes);
    const img = decodeBlp(f.bytes, blpLevelUnder(info, ICON_SIZE));
    const raw = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    const body = await sharp(raw, { raw: { width: img.width, height: img.height, channels: 4 } }).webp({ quality: 84, effort: 6 }).toBuffer();
    await ctx.store.put(key, body);
  }
  return key;
}

/**
 * One wearable. The manifest is written last, so its presence means finished, and it
 * only names models that are already up. A model is shared by every item with the
 * same file and textures, so a colourway re-bakes only what differs.
 */
export async function bakeItem(ctx: BakeContext, spec: ItemSpec): Promise<{ manifest: ItemManifest; entry: ItemEntry; warnings: string[]; inputs: Record<string, string> }> {
  const d = await resolveDisplay(ctx.db, spec.displayId);
  const id = itemUnitId(spec.displayId);
  const files = new Tracked(ctx.source);
  const warnings: string[] = [];
  const races = await allRaces(ctx.db);
  const bodies = allBodies(races);
  const collections: ItemManifest["collections"] = {};
  const boneMemo = new Map<string, Map<number, number>>();
  let phys: ItemManifest["phys"];
  const handFlags = d.flags & 0x1d00;

  const models = new Map<string, Promise<BakedModel>>();
  const lookKey = (file: ModelFile, filter: GeosetFilter, race: number, sex: number, extra = ""): string => {
    const parts: (number | string)[] = [filter.tag, extra];
    for (const list of [d.modelTextures[file.k] ?? [], ...d.extraTextures.filter((e) => e.modelIndex === file.k).map((e) => e.files)]) {
      parts.push(pickTexture(list, race, sex)?.fdid ?? 0);
    }
    return md5Hex(Buffer.from(parts.join(","))).slice(0, 12);
  };
  const adopt = (m: BakedModel) => {
    Object.assign(files.inputs, m.inputs);
    warnings.push(...m.manifest.warnings);
    if (m.manifest.phys && !phys) phys = m.manifest.phys;
  };

  // A model file can be shared with other slots, and then this slot shows only its part.
  const combined = new Map<number, boolean>();
  for (const k of [0, 1]) {
    const res = num(d.row[`ModelResourcesID_${k}`]);
    if (res && !combined.has(res)) combined.set(res, await isCombined(ctx.db, res, spec.slot));
  }
  const combinedK = (k: number) => combined.get(num(d.row[`ModelResourcesID_${k}`])) ?? false;

  const asked = bodies.filter((b) => !ctx.onlyBodies || ctx.onlyBodies.has(b.id));

  // ---- pieces pinned to an attachment, per body: helms are cut per race and sex
  const pinned = d.models.filter((m) => !isSkinnedModel(d, m, spec.slot, spec.inventoryType));
  const attachedBy: NonNullable<ItemManifest["attachedBy"]> = {};
  if (pinned.length) {
    for (const body of asked) {
      const sex: 0 | 1 = body.sex === "male" ? 0 : 1;
      const raceId = raceIdOf(races, body);
      const list: ItemManifest["attached"] = [];
      for (const k of [0, 1]) {
        // A shoulder's two sides can name one resource: position says which file is which.
        const ofK = pinned.filter((m) => m.k === k);
        const sided = ofK.some((m) => m.position >= 0) ? ofK.filter((m) => m.position === k) : ofK;
        const file = fileForBody(sided, raceId, sex);
        if (!file) continue;
        const attachment = attachmentFor(spec.slot, file, spec.inventoryType);
        if (attachment === null || list.some((a) => a.attachment === attachment)) continue;
        const filter = geosetFilter(d, spec.slot, combinedK(k));
        const modelId = `itemm-${file.fdid}-${lookKey(file, filter, raceId, sex)}`;
        if (!models.has(modelId)) {
          models.set(
            modelId,
            bakeModel(ctx, { id: modelId, kind: "item", name: spec.name, m2: file.fdid, look: (model, skin, f) => pieceLook(ctx, d, file, filter, raceId, sex, model, skin, f) }).then((m) => {
              adopt(m);
              return m;
            }),
          );
        }
        await models.get(modelId);
        list.push({ attachment, manifest: modelId, ...(handFlags ? { handFlags } : {}) });
      }
      if (list.length) attachedBy[body.id] = list;
    }
  }
  // Every body wearing the same pieces is the common case: weapons, and capes.
  const lists = Object.values(attachedBy);
  const attached = lists[0] ?? [];
  const samePieces = lists.every((l) => JSON.stringify(l) === JSON.stringify(attached));

  // ---- skinned collections, one per body, with the joints named after that body's
  const skinned = d.models.filter((m) => isSkinnedModel(d, m, spec.slot, spec.inventoryType));
  if (skinned.length) {
    for (const body of asked) {
      const sex: 0 | 1 = body.sex === "male" ? 0 : 1;
      const raceId = raceIdOf(races, body);
      const file = fileForBody(skinned, raceId, sex);
      if (!file) continue;
      const names = await bodyBoneNames(ctx, body, boneMemo);
      const filter = geosetFilter(d, spec.slot, combinedK(file.k));
      const modelId = `itemc-${file.fdid}-${lookKey(file, filter, raceId, sex, body.id)}`;
      let joints: string[] = [];
      adopt(
        await bakeModel(ctx, {
          id: modelId,
          kind: "item",
          name: spec.name,
          m2: file.fdid,
          noClips: true,
          jointKey: body.id,
          look: async (model, skin, f) => {
            // By name hash on both sides: a joint is found by what it is, not where it sits.
            joints = model.bones.map((b, i) => {
              const at = names.get(b.crc);
              return at === undefined ? `own${i}` : `b${at}`;
            });
            const missing = joints.filter((j) => j.startsWith("own")).length;
            const look = await pieceLook(ctx, d, file, filter, raceId, sex, model, skin, f);
            if (missing) look.warnings.push(`${missing} of ${joints.length} joints are not on ${body.id}: they hold their bind pose`);
            return look;
          },
          jointName: (bone) => joints[bone] ?? `own${bone}`,
        }),
      );
      collections[body.id] = { manifest: modelId };
    }
  }

  // ---- what the item paints on the body's own texture slots: a cloak's type 2
  const bodyTextures: NonNullable<ItemManifest["bodyTextures"]> = [];
  if (d.models.length === 0) {
    const list = d.modelTextures[0] ?? [];
    const file = pickTexture(list, 0, 0);
    if (file) {
      const t = await tryTexture(ctx, files, file.fdid, { cap: ITEM_TEXTURE_CAP }, warnings);
      if (t) bodyTextures.push({ type: 2, key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha });
    }
  }

  // ---- body-texture pieces
  const bodyLayers: ItemManifest["bodyLayers"] = [];
  let regions = 0;
  for (const s of d.sections) {
    regions |= 1 << s.section;
    const anyRace = s.files.filter((f) => f.race === 0 && f.usage === 0);
    const pool = anyRace.length ? anyRace : s.files.filter((f) => f.usage === 0);
    if (!anyRace.length && pool.length) warnings.push(`section ${s.section}: only per-race textures, the first stands in`);
    const bySex = new Map<number, (typeof pool)[number]>();
    for (const f of pool) {
      const key = f.sex === 0 || f.sex === 1 ? f.sex : -1;
      if (!bySex.has(key)) bySex.set(key, f);
    }
    for (const [sex, f] of bySex) {
      const t = await tryTexture(ctx, files, f.fdid, { cap: SECTION_CAP }, warnings);
      if (t) bodyLayers.push({ section: s.section, key: t.key, bytes: t.bytes, ...(sex >= 0 ? { sex } : {}) });
    }
  }

  // ---- geoset rules
  const geosetGroups: Record<number, number> = {};
  d.geosetGroups.forEach((v, i) => {
    if (v) geosetGroups[i] = v;
  });
  const helmetHide: Record<string, number[]> = {};
  if (spec.slot === "head") {
    const raceKey = new Map(races.map((r) => [r.raceId, r.key]));
    for (const vis of d.helmetVis) {
      if (!vis) continue;
      for (const row of await ctx.db.where("HelmetGeosetData", "HelmetGeosetVisDataID", vis)) {
        const group = num(row.HideGeosetGroup);
        const race = num(row.RaceID);
        const targets = race === 0 ? ["*"] : allBodies(races).filter((b) => b.raceKey === raceKey.get(race)).map((b) => b.id);
        for (const t of targets) {
          const list = (helmetHide[t] ??= []);
          if (!list.includes(group)) list.push(group);
        }
      }
    }
  }

  let icon = "";
  try {
    icon = await iconObject(ctx, files, spec.iconFdid);
  } catch (e) {
    if (!(e instanceof MissingFile)) throw e;
    warnings.push(`icon ${spec.iconFdid}: ${e.message}`);
  }
  const pad = padBits(d.flags, d.modelTypes);
  const manifest: ItemManifest = {
    formatVersion: FORMAT_VERSION,
    id,
    slot: spec.slot,
    attached,
    ...(samePieces ? {} : { attachedBy }),
    collections,
    bodyLayers,
    ...(bodyTextures.length ? { bodyTextures } : {}),
    geosetGroups,
    ...(phys ? { phys } : {}),
    ...(pad ? { pad } : {}),
    regions,
    // The chest's display flag 4 suppresses the legs.
    ...(spec.slot === "chest" && d.flags & 4 ? { compFlags: 0x20 } : {}),
    ...(Object.keys(helmetHide).length ? { helmetHide } : {}),
  };
  await ctx.store.put(paths.item(id), Buffer.from(JSON.stringify(manifest)));

  const entry: ItemEntry = { id, name: spec.name, circle: icon, tile: "", model: paths.item(id), slot: spec.slot, line: spec.line, icon, ...(spec.facet ? { facet: spec.facet } : {}) };
  await ctx.store.put(entryKey(id), Buffer.from(JSON.stringify(entry)));
  return { manifest, entry, warnings: [...new Set(warnings)], inputs: files.inputs };
}

export function entryKey(id: string): string {
  return `items/${id}/entry.json`;
}

export async function bakeItemUnit(ctx: BakeContext, spec: ItemSpec): Promise<BakeRecord> {
  const start = Date.now();
  const id = itemUnitId(spec.displayId);
  const base = { id, kind: "item", build: BUILD.version, baker: BAKER_VERSION, source: ctx.source.name, bakedAt: new Date().toISOString() };
  try {
    const out = await bakeItem(ctx, spec);
    const rec: BakeRecord = { ...base, status: "ok", inputs: out.inputs, warnings: out.warnings, seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    log(`  ${id}: ${spec.name}, ${out.manifest.attached.length} attached, ${Object.keys(out.manifest.collections).length} collection(s), ${out.manifest.bodyLayers.length} layer(s)`);
    return rec;
  } catch (e) {
    const rec: BakeRecord = { ...base, status: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), inputs: {}, warnings: [], seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  }
}
